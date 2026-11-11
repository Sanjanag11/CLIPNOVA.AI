# ClipNova prompt playground, no GitHub token needed. Paste this whole file into ONE Colab cell (GPU on) and run it.
# Same model and settings as the ClipNova worker: LTX-Video through the diffusers library.
# NOT yet run on a real GPU: if a video comes out black or garbled, or Colab says it ran out of RAM, tell the team.
import time
import torch
from diffusers import LTXPipeline
from diffusers.utils import export_to_video
from IPython.display import Video, display

NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted"

if "pipe" in globals():
    # You ran this cell twice by mistake. Loading again would need double the memory and can crash Colab, so do nothing.
    print("The model is already loaded. Nothing to do: just call play(\"your prompt\").")
else:
    print("Loading LTX-Video (the first time this downloads about 28 GB, 5-15 minutes; later loads read from disk)...")
    t0 = time.time()
    pipe = LTXPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=torch.float16)  # a free T4 has no bfloat16
    pipe.enable_model_cpu_offload()   # keeps GPU memory low
    pipe.vae.enable_tiling()
    print(f"Loaded in {time.time() - t0:.0f}s. Now call play(\"your prompt\")")

if "history" not in globals():
    history = []


def play(prompt, seconds=2, aspect="9:16", steps=20, seed=7):
    """Make one clip and show it. aspect: 9:16 (phone), 16:9, 1:1 or 4:5. More steps = better but slower."""
    prompt = (prompt or "").strip()
    if not prompt:
        print("Type a prompt first.")
        return
    seconds = min(float(seconds), 5.0)                      # this model makes at most about 5 s per clip
    width, height = (768, 512) if aspect == "16:9" else (512, 768)
    frames = max(9, 8 * round((seconds * 24 - 1) / 8) + 1)  # LTX needs 8k+1 frames at 24 fps
    t = time.time()
    try:
        video = pipe(
            prompt=prompt, negative_prompt=NEGATIVE, width=width, height=height, num_frames=frames,
            decode_timestep=0.03, decode_noise_scale=0.025, num_inference_steps=int(steps),
            generator=torch.Generator("cpu").manual_seed(int(seed)),
        ).frames[0]
    except torch.cuda.OutOfMemoryError:
        print("The GPU ran out of memory. Try seconds=1 or fewer steps.")
        return
    path = f"clip{len(history) + 1:03d}.mp4"
    export_to_video(video, path, fps=24)
    history.append((prompt, seconds, aspect, steps, round(time.time() - t, 1)))
    print(f"Done: {seconds:g}s {aspect}, {steps} steps, {time.time() - t:.0f}s to render. Saved {path}")
    display(Video(path, embed=True, width=360))


def summary():
    """Print this and send it to the team."""
    for i, (p, s, a, st, secs) in enumerate(history, 1):
        print(f"{i}. {s:g}s {a} {st} steps, {secs}s render: {p[:90]}")


if not history:
    play("A fluffy orange cat rides a skateboard down a sunny Indian street, handheld vlog style, bright morning light")
