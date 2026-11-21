import base64
import io
import os
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path

import modal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

MODEL_NAME = "htdemucs"
app = modal.App("ai-music-creater-demucs")

model_cache = modal.Volume.from_name("demucs-model-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("fastapi", "demucs")
)

web = FastAPI()


@app.function(
    image=image,
    gpu="A10G",
    memory=32768,
    timeout=1800,
    scaledown_window=60,
    max_containers=1,
    volumes={"/root/.cache/torch": model_cache},
)
def separate_vocals(audio_b64: str, filename: str = "song.mp3") -> bytes:
    raw = base64.b64decode(audio_b64)
    if not raw:
        raise ValueError("The uploaded song is empty.")

    suffix = Path(filename).suffix.lower()
    if suffix not in {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}:
        suffix = ".mp3"

    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        source = root / f"input{suffix}"
        output = root / "stems"
        source.write_bytes(raw)

        command = [
            "python", "-m", "demucs",
            "-n", MODEL_NAME,
            "--two-stems", "vocals",
            "-o", str(output),
            str(source),
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=1500)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "Demucs failed.")[-3000:]
            raise RuntimeError(detail)

        vocals = output / MODEL_NAME / source.stem / "vocals.wav"
        accompaniment = output / MODEL_NAME / source.stem / "no_vocals.wav"
        if not vocals.exists():
            raise RuntimeError("Demucs completed but did not create vocals.wav.")

        model_cache.commit()
        return vocals.read_bytes()


@web.post("/submit")
async def submit(request: Request):
    _authorize(request)
    payload = await request.json()
    audio_b64 = str(payload.get("audio_base64") or "")
    filename = str(payload.get("filename") or "song.mp3")
    if not audio_b64:
        raise HTTPException(status_code=400, detail="An audio file is required.")
    if len(audio_b64) > 140_000_000:
        raise HTTPException(status_code=413, detail="Audio file is too large for this endpoint.")
    call = separate_vocals.spawn(audio_b64, filename)
    return {"call_id": call.object_id, "status": "queued"}


@web.get("/result/{call_id}")
async def result(call_id: str, request: Request):
    _authorize(request)
    try:
        archive_bytes = modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return {"call_id": call_id, "status": "running"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Demucs separation failed: {exc}") from exc

    if not isinstance(archive_bytes, (bytes, bytearray)) or not archive_bytes:
        raise HTTPException(status_code=500, detail="Demucs completed without returning audio stems.")
    return Response(
        content=bytes(archive_bytes),
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="vocals.wav"'},
    )


def _authorize(request: Request):
    expected = os.environ.get("APP_API_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not secrets.compare_digest(supplied, f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="Unauthorized.")


@app.function(image=image, scaledown_window=60)
@modal.asgi_app()
def web_app():
    return web
