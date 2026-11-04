"""A stand-in pipeline that writes REAL mp4 files with ffmpeg, so the whole stack can be run and tested without a GPU.
Enable with WORKER_FAKE=1. It does not understand the prompt."""
from __future__ import annotations

import subprocess
import time

from ..frames import size_for
from .base import Capability, GenerateRequest, ModelFailure, ProgressFn, VideoPipeline


class FakePipeline(VideoPipeline):
    def __init__(self, capability: Capability, delay: float = 0.0, fail_with: ModelFailure | None = None) -> None:
        self.capability = capability
        self.delay = delay
        self.fail_with = fail_with
        self.calls: list[GenerateRequest] = []

    def load(self) -> None:
        pass

    def generate(self, req: GenerateRequest, on_progress: ProgressFn) -> None:
        self.calls.append(req)
        for i in range(1, 5):
            time.sleep(self.delay / 4)
            on_progress(0.2 * i)
        if self.fail_with:
            raise self.fail_with
        w, h = size_for(req.aspect_ratio, self.capability.sizes)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", f"testsrc2=size={w}x{h}:rate={self.capability.fps}:duration={req.seconds}",
             "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", str(req.out_path)],
            check=True, timeout=120,
        )
