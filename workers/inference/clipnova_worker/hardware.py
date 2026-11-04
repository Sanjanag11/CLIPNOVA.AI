"""What GPU we are running on, so models that cannot work here are never offered."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Hardware:
    name: str
    vram_gb: float
    bf16: bool


def detect() -> Hardware | None:
    """Returns None when there is no CUDA GPU (or torch is not installed)."""
    try:
        import torch  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    if not torch.cuda.is_available():
        return None
    p = torch.cuda.get_device_properties(0)
    return Hardware(name=p.name, vram_gb=round(p.total_memory / 1024**3, 1), bf16=bool(torch.cuda.is_bf16_supported()))
