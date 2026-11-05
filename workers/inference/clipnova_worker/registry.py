"""Builds the set of models this worker serves, offering only those that can run on the detected hardware."""
from __future__ import annotations

import logging
import os

from .hardware import Hardware, detect
from .pipelines.base import Capability, VideoPipeline
from .pipelines.fake import FakePipeline

log = logging.getLogger("clipnova.worker")

DEFAULT_MODELS = "wan22-ti2v-5b,ltx-video,cogvideox-2b"


def real_pipelines(hw: Hardware | None) -> dict[str, VideoPipeline]:
    # Imported here so that a machine without torch/diffusers can still run tests and the fake mode.
    from .pipelines.cogvideox import CogVideoX2B  # noqa: PLC0415
    from .pipelines.ltx import LTXVideo  # noqa: PLC0415
    from .pipelines.wan import Wan22TI2V5B  # noqa: PLC0415

    return {p.capability.id: p for p in (Wan22TI2V5B(hw), LTXVideo(hw), CogVideoX2B(hw))}


def fits(cap: Capability, hw: Hardware | None) -> tuple[bool, str]:
    if hw is None:
        return False, "no CUDA GPU detected"
    if hw.vram_gb < cap.min_vram_gb:
        return False, f"needs {cap.min_vram_gb}GB VRAM, GPU has {hw.vram_gb}GB"
    if cap.needs_bf16 and not hw.bf16:
        return False, "needs a bf16-capable GPU"
    return True, ""


def build_registry(names: list[str] | None = None, *, fake: bool | None = None, hw: Hardware | None = None) -> dict[str, VideoPipeline]:
    names = names or [n.strip() for n in os.environ.get("WORKER_MODELS", DEFAULT_MODELS).split(",") if n.strip()]
    fake = fake if fake is not None else os.environ.get("WORKER_FAKE") == "1"
    if fake:
        # Real capability tables, fake rendering: the app sees exactly what the real models would declare.
        delay = float(os.environ.get("WORKER_FAKE_DELAY", "0"))  # seconds per scene, to imitate a slow GPU
        return {pid: FakePipeline(p.capability, delay=delay) for pid, p in real_pipelines(None).items() if pid in names}
    hw = hw if hw is not None else detect()
    ignore = os.environ.get("WORKER_IGNORE_VRAM") == "1"
    out = {}
    for pid, pipe in real_pipelines(hw).items():
        if pid not in names:
            continue
        ok, why = (True, "") if ignore else fits(pipe.capability, hw)
        if ok:
            out[pid] = pipe
        else:
            log.warning("not serving %s: %s", pid, why)
    return out
