import base64
import os
import secrets
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import modal
from fastapi import FastAPI, HTTPException, Request

MODEL_ID = "openai/whisper-large-v3"
app = modal.App("ai-music-creater-whisper")
hf_secret = modal.Secret.from_name("huggingface-secret")
model_cache = modal.Volume.from_name("whisper-model-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("torch", "transformers", "accelerate", "safetensors", "soundfile")
)

web = FastAPI()


@app.cls(
    image=image,
    gpu="A10G",
    memory=32768,
    timeout=1800,
    scaledown_window=120,
    max_containers=1,
    secrets=[hf_secret],
    volumes={"/root/.cache/huggingface": model_cache},
)
class WhisperWorker:
    @modal.enter()
    def load_model(self):
        import torch
        from transformers import pipeline

        self.transcriber = pipeline(
            "automatic-speech-recognition",
            model=MODEL_ID,
            torch_dtype=torch.float16,
            device=0,
            model_kwargs={"low_cpu_mem_usage": True},
        )
        model_cache.commit()

    @modal.method()
    def transcribe(self, audio_b64: str, filename: str = "song.mp3") -> dict[str, Any]:
        raw = base64.b64decode(audio_b64)
        if not raw:
            raise ValueError("The uploaded song is empty.")

        suffix = Path(filename).suffix.lower()
        if suffix not in {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}:
            suffix = ".mp3"

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / f"input{suffix}"
            converted = Path(temp_dir) / "audio-16khz.wav"
            source.write_bytes(raw)
            converted_result = subprocess.run(
                ["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(converted)],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if converted_result.returncode != 0:
                raise RuntimeError((converted_result.stderr or "Could not decode audio.")[-2000:])

            result = self.transcriber(
                str(converted),
                chunk_length_s=30,
                batch_size=8,
                return_timestamps=True,
                generate_kwargs={"task": "transcribe"},
            )

        chunks = []
        for item in result.get("chunks", []) or []:
            timestamp = item.get("timestamp") or (0.0, None)
            chunks.append({
                "text": str(item.get("text") or "").strip(),
                "timestamp": [
                    float(timestamp[0] or 0.0),
                    float(timestamp[1]) if timestamp[1] is not None else None,
                ],
            })
        return {"text": str(result.get("text") or "").strip(), "chunks": chunks}


worker = WhisperWorker()


def authorize(request: Request):
    expected = os.environ.get("APP_API_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not secrets.compare_digest(supplied, f"Bearer {expected}"):
        raise HTTPException(status_code=401, detail="Unauthorized.")


@web.post("/submit")
async def submit(request: Request):
    authorize(request)
    payload = await request.json()
    audio_b64 = str(payload.get("audio_base64") or "")
    filename = str(payload.get("filename") or "song.mp3")
    if not audio_b64:
        raise HTTPException(status_code=400, detail="An audio file is required.")
    if len(audio_b64) > 140_000_000:
        raise HTTPException(status_code=413, detail="Audio file is too large for this endpoint.")
    call = worker.transcribe.spawn(audio_b64, filename)
    return {"call_id": call.object_id, "status": "queued"}


@web.get("/result/{call_id}")
async def result(call_id: str, request: Request):
    authorize(request)
    try:
        output = modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return {"call_id": call_id, "status": "running"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Whisper transcription failed: {exc}") from exc
    return {"status": "completed", **output}


@app.function(image=image, secrets=[hf_secret], scaledown_window=60)
@modal.asgi_app()
def web_app():
    return web
