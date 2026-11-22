import base64
import os
import secrets
import subprocess
import tempfile
from pathlib import Path

import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

APP_NAME = "ai-music-creater-musetalk"
REPO_DIR = "/opt/MuseTalk"
MODEL_DIR = f"{REPO_DIR}/models"

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name("musetalk-model-cache", create_if_missing=True)
service_secret = modal.Secret.from_name("huggingface-secret")

# MuseTalk's published inference stack is pinned to Python 3.10 / CUDA 11.8.
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg", "build-essential", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.0.1+cu118",
        "torchvision==0.15.2+cu118",
        "torchaudio==2.0.2+cu118",
        extra_index_url="https://download.pytorch.org/whl/cu118",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git /opt/MuseTalk"
    )
    .run_commands(
        "cd /opt/MuseTalk && pip install -r requirements.txt",
        "cd /opt/MuseTalk && pip install --no-cache-dir -U openmim",
        "cd /opt/MuseTalk && mim install mmengine",
        "cd /opt/MuseTalk && mim install mmcv==2.0.1",
        "cd /opt/MuseTalk && mim install mmdet==3.1.0",
        "cd /opt/MuseTalk && mim install mmpose==1.1.0",
        "pip install --no-cache-dir gdown fastapi",
    )
)

web = FastAPI()


def _authorize(request: Request) -> None:
    expected = os.environ.get("APP_API_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not secrets.compare_digest(supplied, f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="Unauthorized.")


def _download_models() -> None:
    """Fetch the official MuseTalk 1.5 and supporting inference checkpoints once."""
    import gdown
    from huggingface_hub import hf_hub_download

    model_root = Path(MODEL_DIR)
    required = [
        model_root / "musetalkV15" / "unet.pth",
        model_root / "musetalkV15" / "musetalk.json",
        model_root / "sd-vae" / "diffusion_pytorch_model.bin",
        model_root / "whisper" / "pytorch_model.bin",
        model_root / "dwpose" / "dw-ll_ucoco_384.pth",
        model_root / "syncnet" / "latentsync_syncnet.pt",
        model_root / "face-parse-bisent" / "79999_iter.pth",
        model_root / "face-parse-bisent" / "resnet18-5c106cde.pth",
    ]
    if all(path.exists() and path.stat().st_size > 1024 for path in required):
        return

    folders = [
        "musetalkV15", "sd-vae", "whisper", "dwpose",
        "syncnet", "face-parse-bisent",
    ]
    for folder in folders:
        (model_root / folder).mkdir(parents=True, exist_ok=True)

    hf_token = os.environ.get("HF_TOKEN") or None

    def hf(repo_id: str, filename: str, target: Path) -> None:
        if target.exists() and target.stat().st_size > 1024:
            return
        downloaded = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            token=hf_token,
            local_dir=str(model_root),
            local_dir_use_symlinks=False,
        )
        source = Path(downloaded)
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != target.resolve():
            target.write_bytes(source.read_bytes())

    hf("TMElyralab/MuseTalk", "musetalkV15/unet.pth", required[0])
    hf("TMElyralab/MuseTalk", "musetalkV15/musetalk.json", required[1])
    hf("stabilityai/sd-vae-ft-mse", "diffusion_pytorch_model.bin", required[2])
    hf("openai/whisper-tiny", "pytorch_model.bin", required[3])
    hf("yzd-v/DWPose", "dw-ll_ucoco_384.pth", required[4])
    hf("ByteDance/LatentSync", "latentsync_syncnet.pt", required[5])

    # Supporting model configuration files are required by the official loaders.
    hf("stabilityai/sd-vae-ft-mse", "config.json", model_root / "sd-vae" / "config.json")
    hf("openai/whisper-tiny", "config.json", model_root / "whisper" / "config.json")
    hf("openai/whisper-tiny", "preprocessor_config.json", model_root / "whisper" / "preprocessor_config.json")

    if not required[6].exists() or required[6].stat().st_size < 1024:
        result = gdown.download(
            id="154JgKpzCPW82qINcVieuPH3fZ2e0P812",
            output=str(required[6]),
            quiet=False,
        )
        if not result:
            raise RuntimeError("Could not download the official MuseTalk face-parsing checkpoint.")
    if not required[7].exists() or required[7].stat().st_size < 1024:
        subprocess.run(
            [
                "curl", "-fL",
                "https://download.pytorch.org/models/resnet18-5c106cde.pth",
                "-o", str(required[7]),
            ],
            check=True,
            timeout=300,
        )
    model_cache.commit()


@app.function(
    image=image,
    gpu="A10G",
    memory=49152,
    timeout=1800,
    startup_timeout=1800,
    scaledown_window=120,
    max_containers=1,
    secrets=[service_secret],
    volumes={"/opt/MuseTalk/models": model_cache},
)
def run_musetalk(video_b64: str, audio_b64: str) -> bytes:
    import yaml

    _download_models()
    with tempfile.TemporaryDirectory(prefix="musetalk-job-") as job_dir:
        root = Path(job_dir)
        video_path = root / "input.mp4"
        audio_path = root / "voice.wav"
        config_path = root / "inference.yaml"
        result_dir = root / "results"
        video_path.write_bytes(base64.b64decode(video_b64))
        audio_path.write_bytes(base64.b64decode(audio_b64))
        if video_path.stat().st_size < 1024 or audio_path.stat().st_size < 128:
            raise ValueError("The lip-sync video or audio input is empty.")

        config_path.write_text(
            yaml.safe_dump({
                "task_0": {
                    "video_path": str(video_path),
                    "audio_path": str(audio_path),
                    "result_name": "musetalk-output.mp4",
                }
            }),
            encoding="utf-8",
        )

        command = [
            "python", "-m", "scripts.inference",
            "--inference_config", str(config_path),
            "--result_dir", str(result_dir),
            "--unet_model_path", f"{MODEL_DIR}/musetalkV15/unet.pth",
            "--unet_config", f"{MODEL_DIR}/musetalkV15/musetalk.json",
            "--whisper_dir", f"{MODEL_DIR}/whisper",
            "--version", "v15",
            "--use_float16",
            "--batch_size", "4",
            "--fps", "24",
            "--output_vid_name", "musetalk-output.mp4",
        ]
        completed = subprocess.run(
            command,
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            timeout=1650,
        )
        output_path = result_dir / "v15" / "musetalk-output.mp4"
        if completed.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1024:
            detail = (completed.stderr or completed.stdout or "MuseTalk did not create an output video.")[-6000:]
            raise RuntimeError(f"MuseTalk 1.5 inference failed: {detail}")
        return output_path.read_bytes()


@web.get("/health")
async def health():
    return {"ok": True, "model": "MuseTalk 1.5", "provider": "Hugging Face weights on Modal"}


@web.post("/submit")
async def submit(request: Request):
    _authorize(request)
    payload = await request.json()
    video_b64 = str(payload.get("video_base64") or "")
    audio_b64 = str(payload.get("audio_base64") or "")
    if not video_b64 or not audio_b64:
        raise HTTPException(status_code=400, detail="A base video and vocal audio are required.")
    if len(video_b64) > 120_000_000 or len(audio_b64) > 40_000_000:
        raise HTTPException(status_code=413, detail="The lip-sync inputs exceed the supported upload size.")
    call = run_musetalk.spawn(video_b64, audio_b64)
    return {"call_id": call.object_id, "status": "queued"}


@web.get("/result/{call_id}")
async def result(call_id: str, request: Request):
    _authorize(request)
    try:
        video_bytes = modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return {"call_id": call_id, "status": "running"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"MuseTalk lip-sync failed: {exc}") from exc
    if not isinstance(video_bytes, (bytes, bytearray)) or len(video_bytes) < 1024:
        raise HTTPException(status_code=500, detail="MuseTalk completed without returning a valid MP4.")
    return Response(
        content=bytes(video_bytes),
        media_type="video/mp4",
        headers={"Content-Disposition": 'attachment; filename="musetalk-lipsync.mp4"'},
    )


@app.function(image=image, secrets=[service_secret], scaledown_window=60)
@modal.asgi_app()
def web_app():
    return web
