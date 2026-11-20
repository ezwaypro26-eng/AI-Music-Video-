import os
import secrets
import shutil
import sys
import tempfile
from pathlib import Path

import modal

APP_NAME = "ai-music-creator-ltx"
MODEL_VOLUME_NAME = "ai-music-creator-ltx-models"
MODEL_ROOT = Path("/models/LTX-2.5")
LTX_REPO = Path("/opt/LTX-2")

MODEL_FILES = [
    "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    "vae/ltx-2.5-video-vae-bf16.safetensors",
    "vae/ltx-2.5-audio-vae-bf16.safetensors",
    "model_patches/ltx-2.5-duration-head-bf16.safetensors",
    "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
]

app = modal.App(APP_NAME)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=True)

ltx_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("uv", "fastapi", "python-multipart", "huggingface_hub", "pillow")
    .run_commands(
        "git clone --depth 1 https://github.com/Lightricks/LTX-2.git /opt/LTX-2",
        "cd /opt/LTX-2 && uv sync --frozen",
    )
    .env(
        {
            "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
            "PYTHONPATH": (
                "/opt/LTX-2/packages/ltx-pipelines/src:"
                "/opt/LTX-2/packages/ltx-core/src"
            ),
        }
    )
)


@app.function(
    image=ltx_image,
    gpu="A100-80GB",
    cpu=8,
    memory=65536,
    volumes={"/models": model_volume},
    secrets=[modal.Secret.from_name("ai-music-creator-ltx-secrets")],
    max_containers=1,
    scaledown_window=60,
    timeout=60 * 30,
    startup_timeout=60 * 30,
)
@modal.asgi_app()
def ltx_api():
    # The Modal image builds LTX into its isolated uv environment. Add that
    # environment's packages to this process so the model can stay loaded
    # between requests instead of reloading 66 GiB for every shot.
    venv_site = LTX_REPO / ".venv" / "lib" / "python3.12" / "site-packages"
    sys.path[:0] = [
        str(venv_site),
        str(LTX_REPO / "packages" / "ltx-pipelines" / "src"),
        str(LTX_REPO / "packages" / "ltx-core" / "src"),
    ]

    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.responses import FileResponse
    from starlette.background import BackgroundTask
    from PIL import Image
    from huggingface_hub import snapshot_download
    import torch
    from ltx_pipelines.distilled import DistilledPipeline
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.model_paths import ModelPaths
    from ltx_pipelines.utils.types import ImageConditioningInput, OffloadMode

    model_volume.reload()
    hf_token = os.environ.get("HF_TOKEN")
    api_token = os.environ.get("LTX_API_TOKEN")
    if not hf_token:
        raise RuntimeError("HF_TOKEN is missing from the Modal Secret.")
    if not api_token:
        raise RuntimeError("LTX_API_TOKEN is missing from the Modal Secret.")

    transformer = MODEL_ROOT / MODEL_FILES[0]
    if not transformer.exists():
        snapshot_download(
            repo_id="Lightricks/LTX-2.5",
            allow_patterns=MODEL_FILES,
            local_dir=str(MODEL_ROOT),
            token=hf_token,
        )
        model_volume.commit()

    model_paths = ModelPaths.from_split(
        transformer_path=str(MODEL_ROOT / MODEL_FILES[0]),
        text_encoder_path=str(MODEL_ROOT / MODEL_FILES[1]),
        video_vae_path=str(MODEL_ROOT / MODEL_FILES[2]),
        audio_vae_path=str(MODEL_ROOT / MODEL_FILES[3]),
        duration_head_path=str(MODEL_ROOT / MODEL_FILES[4]),
    )

    pipeline = DistilledPipeline(
        model_paths=model_paths,
        spatial_upsampler_path=str(MODEL_ROOT / MODEL_FILES[5]),
        loras=[],
        offload_mode=OffloadMode.CPU,
    )

    api = FastAPI(title="AI Music Creator - LTX-2.5")

    @api.get("/health")
    def health():
        return {"ok": True, "model": "LTX-2.5 Distilled"}

    @api.post("/generate")
    async def generate(
        image: UploadFile = File(...),
        prompt: str = Form(...),
        aspect_ratio: str = Form("16:9"),
        authorization: str | None = Header(default=None),
    ):
        if not secrets.compare_digest(
            authorization or "", f"Bearer {api_token}"
        ):
            raise HTTPException(status_code=401, detail="Invalid LTX service token.")
        if not prompt.strip():
            raise HTTPException(status_code=400, detail="A motion prompt is required.")
        if aspect_ratio not in {"16:9", "9:16", "1:1"}:
            raise HTTPException(status_code=400, detail="Unsupported aspect ratio.")

        work_dir = Path(tempfile.mkdtemp(prefix="ltx-job-"))
        try:
            image_bytes = await image.read()
            if not image_bytes:
                raise HTTPException(status_code=400, detail="The keyframe image is empty.")

            input_image = work_dir / "keyframe.png"
            with Image.open(__import__("io").BytesIO(image_bytes)) as opened:
                opened.convert("RGB").save(input_image, format="PNG")

            if aspect_ratio == "9:16":
                width, height = 448, 768
            elif aspect_ratio == "1:1":
                width, height = 640, 640
            else:
                width, height = 768, 448

            output_path = work_dir / "ltx-output.mp4"
            with torch.inference_mode():
                result = pipeline(
                    prompt=prompt.strip(),
                    seed=secrets.randbelow(2**31 - 1),
                    height=height,
                    width=width,
                    frame_rate=24.0,
                    images=[ImageConditioningInput.replace(str(input_image), 0, 1.0)],
                    num_frames=121,
                )
                encode_video(
                    result.video,
                    24.0,
                    result.audio,
                    str(output_path),
                    video_chunks_number=None,
                )

            if not output_path.exists() or output_path.stat().st_size < 1024:
                raise RuntimeError("LTX did not produce a valid MP4.")
            return FileResponse(
                path=str(output_path),
                media_type="video/mp4",
                filename="ltx-generated.mp4",
                background=BackgroundTask(shutil.rmtree, work_dir, ignore_errors=True),
            )
        except HTTPException:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=f"LTX generation failed: {exc}") from exc

    return api
