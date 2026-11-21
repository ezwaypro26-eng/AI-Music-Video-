# AI Music Creator

This repository contains the existing AI music-video app. The goal of the provider migration is to keep the current screens, scene workflow, inputs, outputs, and FFmpeg assembly unchanged while moving model execution away from Fal where replacements are ready.

## Model and provider map

| App function | Model / provider target | Current integration status |
|---|---|---|
| Artist portraits and regular scene images | Hugging Face `black-forest-labs/FLUX.1-dev`, hosted on Modal | Modal service code exists in `modal/flux_image_app.py`; deployment and live test must be confirmed. |
| Character-consistent scene images | Hugging Face `black-forest-labs/FLUX.1-Kontext-dev`, hosted on Modal | Uses the same Modal FLUX service; deployment and live test must be confirmed. |
| Song transcription and timestamped lyrics | Hugging Face `openai/whisper-large-v3`, hosted on Modal | Modal service code exists in `modal/whisper_app.py`; deployment and live test must be confirmed. |
| Vocal separation | Demucs v4 `htdemucs`, hosted on Modal | Modal service code exists in `modal/demucs_app.py`; deployment and live test must be confirmed. |
| B-roll image-to-video | Hugging Face `Lightricks/LTX-2.5-Diffusers`, hosted on Modal | Modal service code exists in `modal/ltx_app.py`; deployment and live test must be confirmed. |
| Lip-sync | Hugging Face lip-sync model hosted on Modal | Target provider is Hugging Face/Modal. The model has not yet been selected or integrated. The current server code still calls `fal-ai/sync-lipsync`; keep `FAL_KEY` until that replacement is implemented and tested. |
| Storyboard / AI Director | OpenAI `gpt-4o` and Gemini | Existing integrations; not part of this Modal deployment workflow. |

**Important:** A model file existing in the repository does not mean its Modal service is deployed or working. Confirm each deployment and run an actual app test before treating it as live. The lip-sync migration is not included in the commands below yet.

## Modal secret setup

In the Modal workspace, create or keep a Secret named `huggingface-secret` with these keys:

- `HF_TOKEN` — Hugging Face access token used to download model files.
- `APP_API_TOKEN` — a long random shared token used to protect the app-facing Modal endpoints.

Use the same `APP_API_TOKEN` value in the app host environment variables whose names end in `_API_TOKEN`. Do not commit either secret, put secret values in this README, or paste them into chat.

For GitHub Actions deployment, add a matching Modal API token pair to the repository's **Settings → Secrets and variables → Actions**:

- `MODAL_TOKEN_ID`
- `MODAL_TOKEN_SECRET`

These are Modal deployment credentials, not the Hugging Face token and not `APP_API_TOKEN`.

## Deploy from Terminal (Mac)

Run these commands from the repository's root folder. The first-time setup creates a Python environment and signs the Modal CLI into your Modal account:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip modal fastapi
modal setup
```

Check the Modal Python files, then deploy the four services currently included in the repository:

```bash
python -m py_compile modal/demucs_app.py modal/whisper_app.py modal/ltx_app.py modal/flux_image_app.py

modal deploy modal/demucs_app.py
modal deploy modal/whisper_app.py
modal deploy modal/ltx_app.py
modal deploy modal/flux_image_app.py
```

Each `modal deploy` command prints the deployed web endpoint. Copy each URL from the successful deployment output. The first model request may take longer because the GPU container downloads model weights into its persistent Modal Volume.

To deploy only one service later, run its matching command from the repository root, for example:

```bash
modal deploy modal/whisper_app.py
```

## Deploy through GitHub Actions

The workflow file is `.github/workflows/deploy-modal-ltx.yml`. It runs the app lint/build checks, checks Modal Python syntax, then deploys Demucs, Whisper, LTX, and FLUX in that order.

1. Confirm `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are set in GitHub Actions secrets.
2. Open the repository's **Actions** tab.
3. Select **Deploy Demucs, LTX-2.5 and FLUX to Modal**.
4. Choose **Run workflow** if it is not already triggered by a push to `main`.
5. Open the run and inspect the deploy steps. The final step prints the four Modal service URLs.

The workflow deploys the services; it does not prove that model inference works. Run an actual app test after connecting the URLs.

## Connect the deployed services to the app

Add these variables to the app host's environment settings (for example, the app's Render environment). Use the URL printed for each deployed Modal service. For every `*_API_TOKEN` value below, use the same `APP_API_TOKEN` stored in the Modal `huggingface-secret`.

| App environment variable | Value |
|---|---|
| `MODAL_DEMUCS_URL` | Deployed Demucs web URL |
| `MODAL_DEMUCS_API_TOKEN` | Modal `APP_API_TOKEN` |
| `MODAL_WHISPER_URL` | Deployed Whisper web URL |
| `MODAL_WHISPER_API_TOKEN` | Modal `APP_API_TOKEN` |
| `MODAL_LTX_URL` | Deployed LTX web URL |
| `MODAL_LTX_API_TOKEN` | Modal `APP_API_TOKEN` |
| `MODAL_FLUX_URL` | Deployed FLUX web URL |
| `MODAL_FLUX_API_TOKEN` | Modal `APP_API_TOKEN` |

Keep `FAL_KEY` in the app environment for now: the current lip-sync code still calls Fal. Remove it only after the Hugging Face/Modal lip-sync replacement has been implemented, connected, and successfully tested. Save the environment changes and redeploy/restart the app host so the server receives the new values.

## Cost and runtime notes

- GPU work runs on Modal; Hugging Face is the model source, not the GPU host.
- Modal GPU usage can incur charges while jobs run. Scale-down settings reduce idle runtime but do not make inference free.
- Model caches are stored in Modal Volumes where configured, reducing repeated downloads.
- FLUX and LTX use A100 80 GB configurations; Whisper and Demucs use A10G configurations.
- Deployment and health checks are not substitutes for testing real image generation, transcription, vocal separation, video generation, and lip-sync in the app.

## App workflow preservation

The provider migration is intended to change model connections only. Keep the existing app flow, UI, scene organization, storyboard process, timing data, and FFmpeg final assembly intact. Do not redesign the app as part of this provider work.
