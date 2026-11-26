import gradio as gr
import spaces
import torch
from datetime import datetime, timezone


@spaces.GPU(duration=15)
def check_zerogpu():
    if not torch.cuda.is_available():
        return "The ZeroGPU worker did not attach a CUDA device. Check that this Space is set to ZeroGPU hardware."
    device_name = torch.cuda.get_device_name(0)
    props = torch.cuda.get_device_properties(0)
    return (
        "ZeroGPU is connected.\n"
        f"GPU: {device_name}\n"
        f"GPU memory: {props.total_memory / (1024 ** 3):.1f} GB\n"
        f"PyTorch: {torch.__version__}\n"
        f"Checked: {datetime.now(timezone.utc).isoformat()}"
    )


with gr.Blocks(title="Nocturne ZeroGPU") as demo:
    gr.Markdown(
        "# Nocturne ZeroGPU\n"
        "Private GPU worker for the separate Nocturne Studio build. "
        "Press the button only when you want to test your included ZeroGPU access."
    )
    run = gr.Button("Check ZeroGPU", variant="primary")
    result = gr.Textbox(label="GPU status", lines=6)
    run.click(fn=check_zerogpu, inputs=[], outputs=result)

demo.launch()
