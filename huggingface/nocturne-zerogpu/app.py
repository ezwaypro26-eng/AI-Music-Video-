import json
import os
import uuid
from datetime import datetime, timezone

import gradio as gr
import spaces
import torch
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError

OWNER_USERNAME = "ezwaypro"
DATASET_REPO = "ezwaypro/nocturne-artist-locker"
INDEX_PATH = "artist-locker.json"


@spaces.GPU(duration=1)
def zero_gpu_ready():
    if not torch.cuda.is_available():
        return "ZeroGPU is not attached yet."
    return f"ZeroGPU ready: {torch.cuda.get_device_name(0)}"


CSS = """
.gradio-container {max-width: 1180px !important; background:#101114 !important;}
#hero {padding:22px 26px; border:1px solid #3a3020; border-radius:16px;
       background:linear-gradient(120deg,#191919,#241d12);}
#hero h1 {color:#e8b75a; margin-bottom:4px;}
.muted {color:#aaa;}
"""


def is_owner(profile):
    return bool(profile and profile.username == OWNER_USERNAME)


def get_api():
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError(
            "Private storage is not connected yet. Add the HF_TOKEN secret to this Space."
        )
    return HfApi(token=token)


def read_artists(api):
    try:
        index_file = hf_hub_download(
            repo_id=DATASET_REPO,
            repo_type="dataset",
            filename=INDEX_PATH,
            token=os.environ.get("HF_TOKEN"),
        )
        with open(index_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except EntryNotFoundError:
        return []


def gallery_cards(artists, token):
    cards = []
    for artist in artists:
        image_path = hf_hub_download(
            repo_id=DATASET_REPO,
            repo_type="dataset",
            filename=artist["portrait_path"],
            token=token,
        )
        description = (
            f"**{artist['name']}**\n\n"
            f"{artist.get('visual_prompt') or 'No visual notes yet.'}\n\n"
            f"Added {artist.get('created', 'date unavailable')}"
        )
        cards.append([image_path, description])
    return cards


def check_access(profile: gr.OAuthProfile | None):
    if is_owner(profile):
        return (
            f"Signed in as @{profile.username}. Nocturne owner access granted.",
            gr.update(visible=True),
        )
    if profile:
        return (
            f"Signed in as @{profile.username}, but this account is not authorized.",
            gr.update(visible=False),
        )
    return (
        "Sign in with the authorized Hugging Face account to continue.",
        gr.update(visible=False),
    )


def load_artists(profile: gr.OAuthProfile | None):
    if not is_owner(profile):
        return [], [], "Access denied. Sign in with the authorized owner account."
    try:
        api = get_api()
        artists = read_artists(api)
        cards = gallery_cards(artists, os.environ["HF_TOKEN"])
        return artists, cards, f"{len(artists)} artist(s) loaded from private storage."
    except Exception as exc:
        return [], [], f"Storage connection error: {exc}"


def add_artist(name, prompt, portrait, artists, profile: gr.OAuthProfile | None):
    if not is_owner(profile):
        return artists or [], "Access denied. Sign in with the authorized owner account.", [], "Access denied."
    name = (name or "").strip()
    if not name:
        return artists or [], "Enter an artist name before saving.", [], "No changes."
    if not portrait:
        return artists or [], "Add a reference portrait before saving.", [], "No changes."

    try:
        api = get_api()
        token = os.environ["HF_TOKEN"]
        artist_id = uuid.uuid4().hex
        extension = os.path.splitext(portrait)[1].lower() or ".png"
        portrait_path = f"portraits/{artist_id}{extension}"

        api.upload_file(
            path_or_fileobj=portrait,
            path_in_repo=portrait_path,
            repo_id=DATASET_REPO,
            repo_type="dataset",
            commit_message=f"Add portrait for {name}",
        )

        all_artists = read_artists(api)
        entry = {
            "id": artist_id,
            "name": name,
            "visual_prompt": (prompt or "").strip(),
            "portrait_path": portrait_path,
            "created": datetime.now(timezone.utc).strftime("%b %d, %Y %I:%M %p UTC"),
        }
        all_artists.append(entry)
        api.upload_file(
            path_or_fileobj=json.dumps(all_artists, ensure_ascii=False, indent=2).encode("utf-8"),
            path_in_repo=INDEX_PATH,
            repo_id=DATASET_REPO,
            repo_type="dataset",
            commit_message=f"Save Artist Locker entry: {name}",
        )
        cards = gallery_cards(all_artists, token)
        return all_artists, f"Saved {name} to your private, permanent Artist Locker.", cards, f"{len(all_artists)} artist(s) saved."
    except Exception as exc:
        return artists or [], f"Could not save artist: {exc}", [], "Storage save failed."


def refresh_artists(artists, profile: gr.OAuthProfile | None):
    if not is_owner(profile):
        return [], [], "Access denied. Sign in with the authorized owner account."
    try:
        api = get_api()
        all_artists = read_artists(api)
        cards = gallery_cards(all_artists, os.environ["HF_TOKEN"])
        return all_artists, cards, f"{len(all_artists)} artist(s) refreshed from private storage."
    except Exception as exc:
        return artists or [], [], f"Storage refresh error: {exc}"


with gr.Blocks(
    title="Nocturne Studio",
    theme=gr.themes.Base(primary_hue="amber", secondary_hue="stone", neutral_hue="slate"),
) as demo:
    gr.HTML("""
      <div id="hero">
        <h1>NOCTURNE STUDIO</h1>
        <div class="muted">Artist Locker · Hugging Face ZeroGPU build</div>
        <p class="muted">Build your cast of recurring artists and keep their visual references organized.</p>
      </div>
    """)
    gr.Markdown("### Owner sign-in")
    gr.LoginButton()
    access_status = gr.Markdown("Checking sign-in…")
    with gr.Column(visible=False) as app_panel:
        state = gr.State([])
        with gr.Row():
            with gr.Column(scale=1):
                gr.Markdown("## Add an artist")
                artist_name = gr.Textbox(label="Artist name", placeholder="Enter artist or character name")
                visual_prompt = gr.Textbox(
                    label="Visual notes",
                    placeholder="Describe the look you want to keep consistent...",
                    lines=4,
                )
                portrait = gr.Image(label="Reference portrait", type="filepath", sources=["upload"])
                save = gr.Button("Save artist", variant="primary")
                status = gr.Markdown("Private storage is ready when the HF_TOKEN secret is configured.")
            with gr.Column(scale=1):
                gr.Markdown("## Your artists")
                gallery = gr.Gallery(label="Artist Locker", columns=2, height=420, object_fit="contain")
                refresh = gr.Button("Refresh from private storage")
                count = gr.Markdown("Your saved artists will appear here.")
        gr.Markdown(
            "Artist portraits and details are stored in a separate private Hugging Face dataset. "
            "This Space does not connect to production Nocturne, EZway, Supabase, Render, or Modal."
        )
        save.click(
            add_artist,
            inputs=[artist_name, visual_prompt, portrait, state],
            outputs=[state, status, gallery, count],
        )
        refresh.click(
            refresh_artists,
            inputs=[state],
            outputs=[state, gallery, count],
        )

    demo.load(check_access, inputs=None, outputs=[access_status, app_panel])
    demo.load(load_artists, inputs=None, outputs=[state, gallery, count])

demo.launch(css=CSS)
