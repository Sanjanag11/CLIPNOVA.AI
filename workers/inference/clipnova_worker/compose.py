"""Stitches rendered scenes into one MP4 with ffmpeg (the web app has no ffmpeg; this is the only place that runs it)."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

# Output size per shape (720p class).
OUTPUT_SIZE: dict[str, tuple[int, int]] = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720), "4:5": (720, 900)}
FPS = 24

FONT_CANDIDATES = [
    os.environ.get("CLIPNOVA_FONT_FILE"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]


class ComposeError(Exception):
    pass


def find_font() -> str | None:
    return next((f for f in FONT_CANDIDATES if f and Path(f).exists()), None)


def build_args(inputs: list[Path], out: Path, aspect: str, watermark: bool, font: str | None) -> list[str]:
    """ffmpeg arguments (a list, never a shell string). Every scene is scaled/cropped to the shape, set to 24 fps, then joined."""
    w, h = OUTPUT_SIZE[aspect]
    norm = [f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,fps={FPS},format=yuv420p[v{i}]" for i in range(len(inputs))]
    join = "".join(f"[v{i}]" for i in range(len(inputs))) + f"concat=n={len(inputs)}:v=1:a=0[vc]" if len(inputs) > 1 else "[v0]null[vc]"
    pad = round(w / 36)
    mark = (f"[vc]drawtext=fontfile={font}:text='ClipNova.ai':fontcolor=white@0.85:fontsize={round(h / 32)}:x=w-tw-{pad}:y=h-th-{pad}"
            ":box=1:boxcolor=black@0.35:boxborderw=10[v]") if watermark else "[vc]null[v]"
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *[a for p in inputs for a in ("-i", str(p))],
            "-filter_complex", ";".join([*norm, join, mark]), "-map", "[v]", "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]


def compose(inputs: list[Path], out: Path, aspect: str, watermark: bool, timeout: int = 300) -> None:
    if not inputs:
        raise ComposeError("no scenes to compose")
    if aspect not in OUTPUT_SIZE:
        raise ComposeError(f"unsupported aspect ratio {aspect}")
    font = find_font() if watermark else None
    if watermark and not font:
        # A free-plan video must never ship without its watermark: fail instead.
        raise ComposeError("no font available for the watermark (set CLIPNOVA_FONT_FILE)")
    tmp = out.with_suffix(".tmp.mp4")
    try:
        subprocess.run(build_args(inputs, tmp, aspect, watermark, font), check=True, capture_output=True, timeout=timeout)
        tmp.replace(out)  # never expose a half-written file
    except subprocess.CalledProcessError as e:
        raise ComposeError(f"ffmpeg failed: {e.stderr.decode(errors='replace')[:300]}") from e
    except subprocess.TimeoutExpired as e:
        raise ComposeError("ffmpeg timed out") from e
    finally:
        tmp.unlink(missing_ok=True)
