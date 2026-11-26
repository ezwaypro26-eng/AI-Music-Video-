import spaces
import torch
import gradio as gr
from datetime import datetime, timezone


@spaces.GPU(duration=15)
def run_gpu_check():
    if not torch.cuda.is_available():
        return (
            "The app started, but no CUDA GPU was attached. "
            "The Space may not yet be configured for ZeroGPU."
        )
    props = torch.cuda.get_device_properties(0)
    return (
        "SUCCESS — ZeroGPU worker attached.\n"
        f"GPU: {torch.cuda.get_device_name(0)}\n"
        f"GPU memory: {props.total_memory / (1024 ** 3):.1f} GB\n"
        f"PyTorch: {torch.__version__}\n"
        f"Checked: {datetime.now(timezone.utc).isoformat()}"
    )


with gr.Blocks(title="Nocturne GPU Diagnostic") as demo:
    gr.Markdown(
        "# Nocturne GPU Diagnostic\n"
        "Temporary public test page. It contains no project files or private data. "
        "Press the button to test the included ZeroGPU allocation."
    )
    check = gr.Button("Run GPU check", variant="primary")
    output = gr.Textbox(label="Result", lines=6)
    check.click(fn=run_gpu_check, inputs=[], outputs=output)

demo.launch()
