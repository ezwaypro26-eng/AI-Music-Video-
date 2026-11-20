# AI Music Creator

## Modal LTX-2.5 video generation

The Modal service in `modal/ltx_app.py` handles image-to-video generation for B-roll scenes. The existing app continues to use Fal for artist portraits, image/keyframe generation, audio tools, and lip-sync. Final editing and music muxing remain in the existing FFmpeg pipeline.

### One-time setup

1. In Modal, keep the existing Secret named `huggingface-secret` with `HF_TOKEN`.
2. Add a second key named `APP_API_TOKEN` to that same Modal Secret. Use a long random value. Do not put the value in GitHub or commit it to this repository.
3. Create a Modal API token in Modal Settings. Add its ID and secret to this GitHub repository under **Settings → Secrets and variables → Actions** as `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.
4. In GitHub, run **Actions → Deploy LTX-2.5 to Modal → Run workflow** (or merge this branch after the required secrets are in place).

The workflow deploys the service without starting a GPU generation. The model weights are downloaded only when the first video job is submitted.

### Connect the existing app

After the workflow deploys, copy the web URL printed in the workflow log. In the app host's environment settings, add:

- `MODAL_LTX_URL`: the deployed Modal web URL.
- `MODAL_LTX_API_TOKEN`: the exact same value as `APP_API_TOKEN` in the Modal Secret.

Redeploy the app after adding these environment variables.

### Cost controls

- LTX generation uses one A100 80 GB container maximum.
- The GPU container scales down after one minute without work.
- The model cache is stored in a Modal Volume to avoid downloading the weights on every cold start.
- Deployment itself does not run a video generation. The first actual scene render downloads the gated model weights and incurs GPU usage.

### Rendering behavior

All B-roll video scenes are routed to LTX-2.5 on Modal. Lip-sync remains on Fal. Existing keyframe generation, audio processing, and FFmpeg final assembly are unchanged. The old Wan/Kling quality choices are replaced with one LTX-2.5 provider choice because the previous three provider-specific modes no longer apply.
