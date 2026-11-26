import io
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
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap');
:root { --nocturne-bg:#090a0d; --nocturne-panel:#12151b; --nocturne-line:#292d36; --nocturne-gold:#d6ad68; }
.gradio-container {max-width:1440px !important; background:var(--nocturne-bg) !important; color:#f2f0eb !important; font-family:'DM Sans',sans-serif !important;}
body, .gradio-container {background:var(--nocturne-bg) !important;}
#hero {position:relative; overflow:hidden; padding:42px 44px; margin:12px 0 28px; border:1px solid #383027; border-radius:22px; background:radial-gradient(ellipse at 82% 15%,rgba(190,139,67,.20),transparent 36%),linear-gradient(115deg,#17191f 0%,#101116 58%,#211a12 100%);}
#hero:after {content:'N'; position:absolute; right:7%; top:-65px; font:800 270px/1 'Manrope',sans-serif; color:rgba(214,173,104,.055); pointer-events:none;}
#hero .eyebrow {color:#d6ad68; font-size:11px; letter-spacing:3px; font-weight:700; text-transform:uppercase; margin-bottom:13px;}
#hero h1 {font:800 clamp(32px,5vw,54px)/1.05 'Manrope',sans-serif; letter-spacing:2px; color:#f4eee3; margin:0 0 12px;}
#hero p {color:#b4b0a8; font-size:15px; max-width:620px; margin:0; line-height:1.7;}
#hero .hero-foot {margin-top:22px; color:#d6ad68; font-size:11px; letter-spacing:1.6px; text-transform:uppercase;}
.section-head {border-bottom:1px solid var(--nocturne-line); padding:4px 0 14px; margin-bottom:18px;}
.section-head h2 {font:700 20px 'Manrope',sans-serif; color:#f3eee5; margin:0 0 5px;}
.section-head p {color:#9699a2; font-size:13px; margin:0;}
.panel {background:linear-gradient(145deg,#151820,#101218); border:1px solid var(--nocturne-line); border-radius:18px; padding:22px !important;}
.gradio-container label, .gradio-container .prose {color:#d8d6d0 !important;}
.gradio-container input, .gradio-container textarea {background:#0d1015 !important; border-color:#303540 !important; border-radius:10px !important;}
.gradio-container button.primary {background:linear-gradient(120deg,#d7b36f,#a77a3e) !important; color:#17130d !important; border:0 !important; font-weight:700 !important;}
.gradio-container button {border-radius:10px !important;}
.gradio-container .gallery {border-color:#303540 !important;}
.muted {color:#aaa;}
@media (max-width: 700px) { #hero {padding:28px 22px;} #hero:after {right:-5%; font-size:190px;} }
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
        cards.append((image_path, description))
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
            path_or_fileobj=io.BytesIO(json.dumps(all_artists, ensure_ascii=False, indent=2).encode("utf-8")),
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
        <div class="eyebrow">Your creative universe · private studio</div>
        <h1>NOCTURNE</h1>
        <p>A cinematic workspace for building artists, shaping visual identities, and bringing music videos to life.</p>
        <div class="hero-foot">Artist Locker &nbsp; / &nbsp; Visual continuity &nbsp; / &nbsp; Your world</div>
      </div>
    """)
    gr.Markdown("### Studio access")
    gr.LoginButton()
    access_status = gr.Markdown("Checking sign-in…")
    with gr.Column(visible=False) as app_panel:
        state = gr.State([])
        gr.HTML("""
          <div class="section-head">
            <h2>Artist Locker</h2>
            <p>Keep your recurring cast and their visual references in one private place.</p>
          </div>
        """)
        with gr.Row(equal_height=True):
            with gr.Column(scale=4, elem_classes=["panel"]):
                gr.Markdown("### Add to your cast")
                gr.Markdown("<span style='color:#9699a2'>Create a visual reference that you can return to across projects.</span>")
                artist_name = gr.Textbox(label="Artist / character name", placeholder="e.g. Maya, Lena, Main Artist")
                visual_prompt = gr.Textbox(
                    label="Visual identity notes",
                    placeholder="Hair, wardrobe, features, mood, signature details...",
                    lines=4,
                )
                portrait = gr.Image(label="Portrait reference", type="filepath", sources=["upload"], height=250)
                save = gr.Button("＋  Save to Artist Locker", variant="primary", size="lg")
                status = gr.Markdown("Your portraits are saved to your private Artist Locker.")
            with gr.Column(scale=7, elem_classes=["panel"]):
                with gr.Row():
                    gr.Markdown("### Your saved cast")
                    refresh = gr.Button("↻  Refresh", size="sm")
                count = gr.Markdown("<span style='color:#9699a2'>Your saved artists will appear here.</span>")
                gallery = gr.Gallery(label=None, columns=3, height=520, object_fit="cover", show_label=False)
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
