import base64
import io
import os
import secrets
import tempfile

import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

MODEL_ID = "Lightricks/LTX-2.5-Diffusers"
CACHE_DIR = "/cache/huggingface"

app = modal.App("ai-music-creater-ltx")

model_cache = modal.Volume.from_name("ltx25-model-cache", create_if_missing=True)
hf_secret = modal.Secret.from_name("huggingface-secret")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        "fastapi",
        "torch",
        "torchvision",
        "pillow",
        "numpy",
        "transformers",
        "accelerate",
        "sentencepiece",
        "protobuf",
        "safetensors",
        "imageio[ffmpeg]",
    )
    .pip_install("git+https://github.com/huggingface/diffusers")
    .env({"HF_HOME": CACHE_DIR})
)

web = FastAPI()
_pipeline = None


def _load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    import torch
    from diffusers import LTX2ImageToVideoPipeline

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN is missing from the huggingface-secret Modal Secret.")

    _pipeline = LTX2ImageToVideoPipeline.from_pretrained(
        MODEL_ID,
        token=token,
        cache_dir=CACHE_DIR,
        dtype=torch.bfloat16,
    )
    _pipeline.enable_sequential_cpu_offload(device="cuda")
    _pipeline.vae.enable_tiling()
    model_cache.commit()
    return _pipeline


@app.function(
    image=image,
    gpu="A100-80GB",
    memory=131072,
    timeout=3600,
    startup_timeout=1800,
    scaledown_window=60,
    max_containers=1,
    secrets=[hf_secret],
    volumes={"/cache": model_cache},
)
def generate_video(image_b64: str, prompt: str, aspect_ratio: str = "16:9", seed: int = 42) -> bytes:
    import torch
    from PIL import Image
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video

    raw = base64.b64decode(image_b64)
    source_image = Image.open(io.BytesIO(raw)).convert("RGB")

    # LTX-2.5 requires dimensions divisible by 32. These preserve the
    # requested aspect ratios before the app's final 1080p FFmpeg scaling.
    if aspect_ratio == "9:16":
        width, height = 544, 960
    elif aspect_ratio == "1:1":
        width, height = 512, 512
    else:
        width, height = 960, 544

    pipe = _load_pipeline()
    video, _audio = pipe(
        image=source_image,
        prompt=prompt,
        width=width,
        height=height,
        num_frames=121,
        frame_rate=24.0,
        sigmas=DISTILLED_SIGMA_VALUES,
        guidance_scale=1.0,
        audio_guidance_scale=1.0,
        generator=torch.Generator(device="cuda").manual_seed(seed),
        output_type="np",
        return_dict=False,
    )

    with tempfile.NamedTemporaryFile(suffix=".mp4") as output_file:
        encode_video(video[0], fps=24.0, output_path=output_file.name)
        output_file.seek(0)
        return output_file.read()


@web.post("/submit")
async def submit(request: Request):
    _authorize(request)
    payload = await request.json()
    image_b64 = str(payload.get("image_base64") or "")
    prompt = str(payload.get("prompt") or "").strip()
    aspect_ratio = str(payload.get("aspect_ratio") or "16:9")

    if not image_b64 or not prompt:
        raise HTTPException(status_code=400, detail="A storyboard image and motion prompt are required.")
    if aspect_ratio not in ("16:9", "9:16", "1:1"):
        aspect_ratio = "16:9"

    call = generate_video.spawn(image_b64, prompt, aspect_ratio)
    return {"call_id": call.object_id, "status": "queued"}


@web.get("/result/{call_id}")
async def result(call_id: str, request: Request):
    _authorize(request)
    try:
        video_bytes = modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return {"call_id": call_id, "status": "running"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"LTX generation failed: {exc}") from exc

    if not isinstance(video_bytes, (bytes, bytearray)) or not video_bytes:
        raise HTTPException(status_code=500, detail="LTX completed without returning an MP4.")
    return Response(
        content=bytes(video_bytes),
        media_type="video/mp4",
        headers={"Content-Disposition": 'attachment; filename="ltx-scene.mp4"'},
    )


def _authorize(request: Request):
    expected = os.environ.get("APP_API_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not secrets.compare_digest(supplied, f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="Unauthorized.")


@app.function(
    image=image,
    secrets=[hf_secret],
    scaledown_window=60,
)
@modal.asgi_app()
def web_app():
    return web
