"""Pure frame/size maths. No torch needed, so it is fully unit-tested on a laptop."""
from __future__ import annotations

Size = tuple[int, int]  # (width, height)


def frame_count(seconds: float, fps: int, step: int, max_frames: int) -> int:
    """Number of frames for `seconds` of video where the model needs `step*k + 1` frames (4k+1 for Wan, 8k+1 for LTX/Cog).

    Rounds to the nearest valid count, never below `step + 1` and never above `max_frames`
    (which must itself satisfy the rule).
    """
    if seconds <= 0 or fps <= 0:
        raise ValueError("seconds and fps must be positive")
    if (max_frames - 1) % step != 0:
        raise ValueError(f"max_frames={max_frames} does not satisfy {step}k+1")
    wanted = round(seconds * fps)
    n = step * round((wanted - 1) / step) + 1
    return max(step + 1, min(n, max_frames))


def orientation_for(aspect_ratio: str) -> str:
    """Models render either landscape or portrait; square and 4:5 are produced from portrait and cropped by the app."""
    if aspect_ratio not in ("9:16", "16:9", "1:1", "4:5"):
        raise ValueError(f"unsupported aspect ratio {aspect_ratio}")
    return "landscape" if aspect_ratio == "16:9" else "portrait"


def size_for(aspect_ratio: str, sizes: dict[str, Size]) -> Size:
    """Picks the model's native size for the requested shape; raises if the model has no such orientation."""
    o = orientation_for(aspect_ratio)
    if o not in sizes:
        raise ValueError(f"model has no {o} size")
    return sizes[o]
