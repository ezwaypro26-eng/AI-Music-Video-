import base64
import io
import os
import secrets

import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from PIL import Image

APP_NAME = "ai-music-creater-flux"
FLUX_DEV_ID = "black-forest-labs/FLUX.1-dev"
FLUX_KONTEXT_ID = "black-forest-labs/FLUX.1-Kontext-dev"
CACHE_DIR = "/cache/huggingface"

app = modal.App(APP_NAME)
cache = modal.Volume.from_name("flux-model-cache", create_if_missing=True)
hf_secret = modal.Secret.from_name("huggingface-secret")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "torch",
        "transformers",
        "accelerate",
        "safetensors",
        "sentencepiece",
        "protobuf",
        "pillow",
        "fastapi",
    )
    .pip_install("git+https://github.com/huggingface/diffusers")
    .env({"HF_HOME": CACHE_DIR})
)

web = FastAPI()
_pipelines = {}


def _load_pipeline(model_name: str):
    import torch
    from diffusers import FluxKontextPipeline, FluxPipeline

    if model_name in _pipelines:
        return _pipelines[model_name]

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN is missing from the Modal huggingface-secret.")
    if model_name == "flux-kontext":
        pipeline = FluxKontextPipeline.from_pretrained(
            FLUX_KONTEXT_ID,
            torch_dtype=torch.bfloat16,
            token=token,
            cache_dir=CACHE_DIR,
        )
    else:
        pipeline = FluxPipeline.from_pretrained(
            FLUX_DEV_ID,
            torch_dtype=torch.bfloat16,
            token=token,
            cache_dir=CACHE_DIR,
        )

    pipeline.enable_model_cpu_offload()
    _pipelines[model_name] = pipeline
    cache.commit()
    return pipeline


@app.function(
    image=image,
    gpu="A100-80GB",
    memory=131072,
    timeout=900,
    startup_timeout=1800,
    scaledown_window=60,
    max_containers=1,
    secrets=[hf_secret],
    volumes={"/cache": cache},
)
def generate_image(
    model_name: str,
    prompt: str,
    width: int,
    height: int,
    reference_image_base64: str = "",
    warmup_only: bool = False,
) -> bytes:
    import torch

    if width < 256 or height < 256 or width > 1536 or height > 1536:
        raise ValueError("Image dimensions must be between 256 and 1536 pixels.")

    if warmup_only:
        _load_pipeline(model_name)
        torch.cuda.empty_cache()
        return b""

    if model_name == "flux-kontext":
        if not reference_image_base64:
            raise ValueError("FLUX Kontext requires a reference image.")
        raw = base64.b64decode(reference_image_base64)
        reference = Image.open(io.BytesIO(raw)).convert("RGB")
        reference = reference.resize((width, height), Image.Resampling.LANCZOS)
        pipeline = _load_pipeline("flux-kontext")
        result = pipeline(
            image=reference,
            prompt=prompt,
            num_inference_steps=28,
            guidance_scale=2.5,
        ).images[0]
    elif model_name == "flux-dev":
        pipeline = _load_pipeline("flux-dev")
        result = pipeline(
            prompt=prompt,
            width=width,
            height=height,
            num_inference_steps=28,
            guidance_scale=3.5,
        ).images[0]
    else:
        raise ValueError("Unknown FLUX model requested.")

    output = io.BytesIO()
    result.save(output, format="PNG")
    torch.cuda.empty_cache()
    return output.getvalue()


@web.get("/health")
async def health():
    return {"ok": True, "models": [FLUX_DEV_ID, FLUX_KONTEXT_ID]}


@web.post("/warmup")
async def warmup(request: Request):
    _authorize(request)
    call = generate_image.spawn("flux-kontext", "warmup", 512, 512, "", True)
    return {"call_id": call.object_id, "status": "warming"}


@web.post("/generate")
async def generate(request: Request):
    _authorize(request)
    payload = await request.json()
    model_name = str(payload.get("model") or "flux-dev")
    prompt = str(payload.get("prompt") or "").strip()
    width = int(payload.get("width") or 1024)
    height = int(payload.get("height") or 1024)
    reference = str(payload.get("reference_image_base64") or "")

    if not prompt:
        raise HTTPException(status_code=400, detail="An image prompt is required.")
    if model_name not in ("flux-dev", "flux-kontext"):
        raise HTTPException(status_code=400, detail="Unsupported FLUX model.")
    if model_name == "flux-kontext" and not reference:
        raise HTTPException(status_code=400, detail="FLUX Kontext requires a reference image.")

    try:
        image_bytes = generate_image.remote(model_name, prompt, width, height, reference)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"FLUX image generation failed: {exc}") from exc

    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={"Content-Disposition": 'inline; filename="flux-image.png"'},
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
