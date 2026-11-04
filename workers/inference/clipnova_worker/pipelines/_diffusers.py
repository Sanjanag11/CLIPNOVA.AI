"""Shared helpers for the diffusers-based pipelines. torch/diffusers are imported lazily, only on a GPU machine."""
from __future__ import annotations

from pathlib import Path

from ..hardware import Hardware
from .base import ModelFailure, ProgressFn


def pick_dtype(hw: Hardware | None, prefer_bf16: bool = True):
    import torch  # noqa: PLC0415

    return torch.bfloat16 if (prefer_bf16 and hw and hw.bf16) else torch.float16


def step_callback(on_progress: ProgressFn, total_steps: int):
    """diffusers calls this after every denoising step; the last 5% is left for decoding and encoding."""

    def cb(_pipe, step: int, _timestep, kwargs: dict):
        on_progress(min(0.95, 0.95 * (step + 1) / max(1, total_steps)))
        return kwargs

    return cb


def generator(seed: int):
    import torch  # noqa: PLC0415

    return torch.Generator("cpu").manual_seed(seed)


def export(frames, path: Path, fps: int) -> None:
    from diffusers.utils import export_to_video  # noqa: PLC0415

    export_to_video(frames, str(path), fps=fps)


def classify(e: Exception) -> ModelFailure:
    """Turns a library exception into a verdict the app can act on."""
    if type(e).__name__ == "OutOfMemoryError":
        # Retrying with the same settings cannot succeed; the app should try a lighter model instead.
        return ModelFailure("OOM", "the GPU ran out of memory", retryable=False)
    return ModelFailure("MODEL_ERROR", f"{type(e).__name__}: {str(e)[:200]}", retryable=True)


def free_gpu() -> None:
    try:
        import gc  # noqa: PLC0415

        import torch  # noqa: PLC0415

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass
