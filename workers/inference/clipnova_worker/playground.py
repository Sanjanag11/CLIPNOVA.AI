"""A prompt playground: load a model once, then type prompts and watch the videos.

In a Colab/Kaggle notebook:
    from clipnova_worker.playground import Playground
    pg = Playground()          # picks LTX-Video; loads on first use
    pg.play("A cat rides a skateboard down a sunny street")

No web app and no server. Every clip is kept in ./playground_out and listed in pg.history.
`Playground(fake=True)` checks the plumbing without a GPU (it renders ffmpeg test patterns).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from .hardware import detect
from .pipelines.base import GenerateRequest, ModelFailure
from .registry import build_registry

MAX_PROMPT = 1500

# Prompts worth trying first: the kind of scenes ClipNova users will describe (English; the app will translate other languages later).
PRESETS = [
    "A fluffy orange cat rides a skateboard down a sunny Indian street, handheld vlog style, bright morning light",
    "A young woman in a yellow hoodie rides a scooter through busy Pune morning traffic, chai stalls blurring past, cinematic",
    "A tiny robot waters plants on a balcony at golden hour, soft focus, gentle camera push-in",
    "A chef tosses a flaming wok in a street food stall at night, steam and sparks, close-up, shallow depth of field",
    "A paper boat floats down a rain-filled street, children's feet splash nearby, slow motion, monsoon light",
]


@dataclass
class Clip:
    prompt: str
    path: Path
    seconds: float
    aspect: str
    steps: int
    seed: int
    render_seconds: float
    peak_vram_gb: float | None


def _peak_vram() -> float | None:
    try:
        import torch  # noqa: PLC0415

        return round(torch.cuda.max_memory_allocated() / 1024**3, 1) if torch.cuda.is_available() else None
    except Exception:  # noqa: BLE001
        return None


def _reset_peak() -> None:
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:  # noqa: BLE001
        pass


class Playground:
    def __init__(self, model: str = "ltx-video", fake: bool = False, out: str = "playground_out") -> None:
        hw = detect()
        print(f"GPU: {hw.name}, {hw.vram_gb} GB" if hw else "GPU: none detected")
        reg = build_registry([model], fake=fake, hw=hw)
        if model not in reg:
            raise RuntimeError(
                f"'{model}' cannot run here (needs a GPU with enough memory). In Colab: Runtime -> Change runtime type -> T4 GPU. "
                "To test the plumbing without a GPU, use Playground(fake=True).")
        self.pipe = reg[model]
        self.cap = self.pipe.capability
        self.out = Path(out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.history: list[Clip] = []
        self._loaded = False

    def load(self) -> None:
        if self._loaded:
            return
        print(f"Loading {self.cap.name} (the first time this downloads several GB)...", flush=True)
        t = time.time()
        self.pipe.load()
        self._loaded = True
        print(f"Loaded in {time.time() - t:.0f}s")

    def make(self, prompt: str, seconds: float = 2.0, aspect: str = "9:16", steps: int = 20, seed: int | None = None) -> Clip:
        """Renders one clip. Raises ValueError for a bad request and RuntimeError (with a plain reason) if the model fails."""
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("Type a prompt first.")
        if len(prompt) > MAX_PROMPT:
            raise ValueError(f"That prompt is {len(prompt)} characters; the limit is {MAX_PROMPT}.")
        if not 4 <= steps <= 100:
            raise ValueError("steps must be between 4 and 100 (fewer = faster, lower quality).")
        if seconds <= 0:
            raise ValueError("seconds must be positive.")
        if seconds > self.cap.max_seconds:
            print(f"Note: {self.cap.name} makes at most {self.cap.max_seconds:g}s per clip; using that.")
            seconds = self.cap.max_seconds
        if aspect not in self.cap.aspect_ratios:
            print(f"Note: {self.cap.name} supports {', '.join(self.cap.aspect_ratios)}; using {self.cap.aspect_ratios[0]}.")
            aspect = self.cap.aspect_ratios[0]
        seconds = float(seconds)
        seed = int(time.time()) % 2**31 if seed is None else seed
        self.load()
        path = self.out / f"clip{len(self.history) + 1:03d}.mp4"
        path.unlink(missing_ok=True)
        _reset_peak()
        t = time.time()
        try:
            self.pipe.generate(GenerateRequest(prompt, "", seconds, aspect, seed, steps, path),
                               lambda p: print(f"\rRendering... {p:4.0%}", end="", flush=True))
            print()
        except ModelFailure as e:
            hint = " Try a shorter clip or fewer steps." if e.code == "OOM" else ""
            raise RuntimeError(f"The model could not make this clip ({e.code}): {e}.{hint}") from e
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"The model failed: {type(e).__name__}: {str(e)[:200]}") from e
        finally:
            try:
                self.pipe.cleanup()
            except Exception:  # noqa: BLE001
                pass
        clip = Clip(prompt, path, seconds, aspect, steps, seed, round(time.time() - t, 1), _peak_vram())
        self.history.append(clip)
        return clip

    def play(self, prompt: str, seconds: float = 2.0, aspect: str = "9:16", steps: int = 20, seed: int | None = None, width: int = 360) -> Clip | None:
        """make() + show the video + print a one-line summary. Errors are printed, not raised, so a notebook cell stays tidy."""
        try:
            clip = self.make(prompt, seconds, aspect, steps, seed)
        except (ValueError, RuntimeError) as e:
            print(f"\n{e}")
            return None
        mem = f", peak GPU memory {clip.peak_vram_gb} GB" if clip.peak_vram_gb is not None else ""
        print(f"Done: {clip.seconds:g}s {clip.aspect}, {clip.steps} steps, rendered in {clip.render_seconds}s{mem}. Saved {clip.path}")
        try:
            from IPython.display import Video, display  # noqa: PLC0415

            display(Video(str(clip.path), embed=True, width=width))
        except Exception:  # noqa: BLE001
            pass
        return clip

    def summary(self) -> str:
        """All clips made so far, for pasting back to the team."""
        if not self.history:
            return "No clips yet."
        rows = [f"{i}. {c.seconds:g}s {c.aspect} {c.steps} steps, {c.render_seconds}s render"
                f"{'' if c.peak_vram_gb is None else f', {c.peak_vram_gb} GB'}: {c.prompt[:90]}" for i, c in enumerate(self.history, 1)]
        return "\n".join(rows)
