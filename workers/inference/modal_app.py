"""Deploys the worker on Modal (https://modal.com): a GPU that exists only while a video renders, billed per second.

    pip install modal && modal setup
    modal secret create clipnova-worker WORKER_TOKEN=<a long random string>
    modal deploy modal_app.py          # prints the https URL -> CLIPNOVA_WORKER_URL in the web app
    # first run downloads the model weights into a cached volume (several GB); later runs reuse them

NOT TESTED: this file was written without access to Modal or a GPU. Expect to adjust it on first deploy.
Keep CLIPNOVA_GPU in step with what you want to serve (see README: an L4/A10G/L40S 24GB+ serves all three models).
"""
import os

import modal

GPU = os.environ.get("CLIPNOVA_GPU", "L4")

app = modal.App("clipnova-worker")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch", "diffusers>=0.35", "transformers>=4.50", "accelerate", "sentencepiece", "ftfy", "protobuf",
        "imageio", "imageio-ffmpeg", "fastapi>=0.110", "uvicorn>=0.29", "pydantic>=2.6",
    )
    # One model for now (LTX-Video: fits a 16-24 GB GPU, portrait, fast). Add more ids, comma separated, to serve more.
    .env({"HF_HOME": "/cache/hf", "WORKER_DATA_DIR": "/tmp/clipnova-worker", "WORKER_MODELS": os.environ.get("CLIPNOVA_MODELS", "ltx-video")})
    .add_local_python_source("clipnova_worker")
)
weights = modal.Volume.from_name("clipnova-hf-cache", create_if_missing=True)


# Job state lives in memory, so there must be exactly ONE container; it accepts many HTTP calls at once
# (status polls arrive while a video renders) and keeps the GPU busy with one job at a time.
@app.function(
    image=image, gpu=GPU, volumes={"/cache": weights}, secrets=[modal.Secret.from_name("clipnova-worker")],
    max_containers=1, scaledown_window=600, timeout=3600,
)
@modal.concurrent(max_inputs=32)
@modal.asgi_app()
def serve():
    from clipnova_worker.app import create_app
    from clipnova_worker.registry import build_registry

    return create_app(build_registry())
