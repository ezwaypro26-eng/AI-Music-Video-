# AI Music Creator

## Video generation

B-roll image-to-video generation runs on the self-hosted LTX-2.5 Distilled service on Modal.
Kling and Wan are not used. Flux image generation, Flux Kontext image editing, and the
separate fal.ai sync-lipsync workflow remain unchanged.

### Modal setup

1. Accept the LTX-2.5 model terms on Hugging Face: https://huggingface.co/Lightricks/LTX-2.5
2. Create a Hugging Face read token with access to gated repositories.
3. Install Modal locally: `python -m pip install modal` and authenticate with `modal setup`.
4. Create the Modal secret (use your own long random API token; do not commit it):

   ```bash
   modal secret create ai-music-creator-ltx-secrets HF_TOKEN=hf_REPLACE_ME LTX_API_TOKEN=REPLACE_WITH_LONG_RANDOM_SECRET
   ```

5. Deploy the service from the repository root:

   ```bash
   modal deploy modal_ltx/app.py
   ```

6. Copy the deployed `/generate` endpoint URL into the app's environment as
   `MODAL_LTX_URL`. Set `MODAL_LTX_TOKEN` to the same value used for
   `LTX_API_TOKEN` in the Modal Secret.

The Modal service uses one A100 80GB container, a persistent volume for the model weights,
a single generation at a time, and a 60-second scale-down window. It downloads the gated
LTX-2.5 weights only on the first deployment/startup and reuses the cached volume.
The service scales to zero when idle. The first cold start will take longer because the
model files total roughly 66 GiB.

### App environment

Keep `FAL_KEY` configured for Flux image generation, Flux Kontext, and any lip-sync shots.
B-roll rendering itself uses `MODAL_LTX_URL` and `MODAL_LTX_TOKEN`; projects containing
only B-roll no longer require `FAL_KEY` just to render the video.

Generated LTX audio is discarded by the existing FFmpeg assembly step; the app continues
to use the uploaded song as the final soundtrack.
