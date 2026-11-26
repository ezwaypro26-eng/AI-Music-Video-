import gradio as gr
import spaces
import torch
from datetime import datetime

# Hugging Face requires at least one @spaces.GPU function in a ZeroGPU Space.
# This function is registered at startup but is NOT called by Artist Locker.
# Therefore loading or saving an artist does not request GPU time.
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

def add_artist(name, prompt, portrait, artists):
    name = (name or "").strip()
    if not name:
        return artists or [], "Enter an artist name before saving.", None
    if not portrait:
        return artists or [], "Add a reference portrait before saving.", None
    artists = list(artists or [])
    entry = {
        "name": name,
        "visual_prompt": (prompt or "").strip(),
        "portrait": portrait,
        "created": datetime.now().strftime("%b %d, %Y %I:%M %p"),
    }
    artists.append(entry)
    cards = [
        [a["portrait"], f"**{a['name']}**\n\n{a['visual_prompt'] or 'No visual notes yet.'}\n\nAdded {a['created']}"]
        for a in artists
    ]
    return artists, f"Added {name} to this session's Artist Locker preview.", cards

def refresh_artists(artists):
    cards = [
        [a["portrait"], f"**{a['name']}**\n\n{a['visual_prompt'] or 'No visual notes yet.'}\n\nAdded {a['created']}"]
        for a in (artists or [])
    ]
    return cards, f"{len(artists or [])} artist(s) in this session."

with gr.Blocks(title="Nocturne Studio", theme=gr.themes.Base(
    primary_hue="amber", secondary_hue="stone", neutral_hue="slate"
)) as demo:
    state = gr.State([])
    gr.HTML("""
      <div id="hero">
        <h1>NOCTURNE STUDIO</h1>
        <div class="muted">Artist Locker · Private Hugging Face build</div>
        <p class="muted">Build your cast of recurring artists and keep their visual references organized.</p>
      </div>
    """)
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("## Add an artist")
            artist_name = gr.Textbox(label="Artist name", placeholder="Enter artist or character name")
            visual_prompt = gr.Textbox(
                label="Visual notes",
                placeholder="Describe the look you want to keep consistent...",
                lines=4
            )
            portrait = gr.Image(label="Reference portrait", type="filepath", sources=["upload"])
            save = gr.Button("Add to Artist Locker", variant="primary")
            status = gr.Markdown("**Ready.** Artist Locker does not request GPU time.")
        with gr.Column(scale=1):
            gr.Markdown("## Your artists")
            gallery = gr.Gallery(label="Artist Locker preview", columns=2, height=420, object_fit="contain")
            refresh = gr.Button("Refresh preview")
            count = gr.Markdown("No artists added in this session yet.")
    gr.Markdown(
        "### First milestone\n"
        "Artist entries are currently held only in this session and will not survive a restart. "
        "Secure permanent storage is the next step. This Space is separate from production Nocturne, "
        "EZway, Render, and Modal. No GPU or paid compute is used by the Artist Locker."
    )
    save.click(add_artist, [artist_name, visual_prompt, portrait, state], [state, status, gallery])
    refresh.click(refresh_artists, [state], [gallery, count])

demo.launch(css=CSS)
