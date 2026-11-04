"""The contract every model implements. The app never sees model-specific code, only this."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..frames import Size

ProgressFn = Callable[[float], None]


class ModelFailure(Exception):
    """A failure with a stable code and a verdict on whether trying again can help."""

    def __init__(self, code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class Capability:
    """What a model can do on THIS worker. Reported to the app via /v1/models; the app does not assume any of it."""

    id: str
    name: str
    modes: tuple[str, ...]            # "t2v", "i2v" ... only modes that are implemented AND verified
    aspect_ratios: tuple[str, ...]
    max_seconds: float
    fps: int
    sizes: dict[str, Size]
    min_vram_gb: float
    needs_bf16: bool = False
    licence: str = ""
    notes: str = ""
    extra: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class GenerateRequest:
    prompt: str
    negative_prompt: str
    seconds: float
    aspect_ratio: str
    seed: int
    steps: int | None
    out_path: Path


class VideoPipeline(ABC):
    capability: Capability

    @abstractmethod
    def load(self) -> None:
        """Downloads/loads weights. Called lazily on the first job."""

    @abstractmethod
    def generate(self, req: GenerateRequest, on_progress: ProgressFn) -> None:
        """Renders to req.out_path (an .mp4). Report progress 0..1. Raise ModelFailure for classified errors."""

    def cleanup(self) -> None:  # noqa: B027
        """Free GPU memory after a job. Optional."""
