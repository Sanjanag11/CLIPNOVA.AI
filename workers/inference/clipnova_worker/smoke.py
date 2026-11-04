"""One-command model test: loads each model this GPU can run, makes a short clip, and reports speed, memory and the file.

    python -m clipnova_worker.smoke                          # every model that fits this GPU
    python -m clipnova_worker.smoke --model ltx-video --seconds 2 --prompt "a cat on a skateboard"
    python -m clipnova_worker.smoke --fake                   # no GPU: checks the plumbing with test patterns

No web app, no server. Videos are written to ./smoke_out (override with --out).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .hardware import detect
from .pipelines.base import GenerateRequest, ModelFailure
from .registry import DEFAULT_MODELS, build_registry

DEFAULT_PROMPT = "A fluffy orange cat rides a skateboard down a sunny street, smooth camera, cinematic lighting"


def _peak_vram_gb() -> float | None:
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


def _probe(path: Path) -> str:
    if not shutil.which("ffprobe"):
        return "ffprobe not installed"
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration",
                        "-of", "json", str(path)], capture_output=True, text=True)
    try:
        j = json.loads(r.stdout)
        s = j["streams"][0]
        num, den = (int(x) for x in s["r_frame_rate"].split("/"))
        return f'{s["width"]}x{s["height"]}, {num / den:g} fps, {float(j["format"]["duration"]):.1f}s'
    except Exception:  # noqa: BLE001
        return "unreadable video"


def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", action="append", help="model id (repeatable); default: all that fit this GPU")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--seconds", type=float, default=2.0)
    ap.add_argument("--aspect", default="9:16", choices=["9:16", "16:9", "1:1", "4:5"])
    ap.add_argument("--steps", type=int, default=20, help="fewer steps = faster, lower quality")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="smoke_out")
    ap.add_argument("--fake", action="store_true", help="no GPU: render ffmpeg test patterns")
    a = ap.parse_args(argv)

    hw = detect()
    print(f"GPU: {hw.name}, {hw.vram_gb} GB, bf16={hw.bf16}" if hw else "GPU: none detected")
    names = a.model or DEFAULT_MODELS.split(",")
    reg = build_registry(names, fake=a.fake, hw=hw)
    skipped = [n for n in names if n not in reg]
    if skipped:
        print("not tested (does not fit this GPU, or unknown):", ", ".join(skipped))
    if not reg:
        print("Nothing to test. In a notebook, switch the runtime to a GPU. To test the plumbing only, add --fake.")
        return 2

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows, failed = [], 0
    for mid, pipe in reg.items():
        cap = pipe.capability
        seconds = min(a.seconds, cap.max_seconds)
        aspect = a.aspect if a.aspect in cap.aspect_ratios else cap.aspect_ratios[0]
        if (seconds, aspect) != (a.seconds, a.aspect):
            print(f"[{mid}] adjusted to {seconds}s, {aspect} (the model's limits)")
        path = out / f"{mid}.mp4"
        path.unlink(missing_ok=True)
        print(f"[{mid}] loading and rendering {seconds}s {aspect} at {a.steps} steps (first run downloads the weights)...", flush=True)
        _reset_peak()
        t0 = time.time()
        try:
            pipe.load()
            t_load = time.time() - t0
            t1 = time.time()
            pipe.generate(GenerateRequest(a.prompt, "", seconds, aspect, a.seed, a.steps, path),
                          lambda p: print(f"\r[{mid}] {p:4.0%}", end="", flush=True))
            print()
            rows.append((mid, "OK", f"load {t_load:.0f}s, render {time.time() - t1:.0f}s", f"{_peak_vram_gb() or '-'} GB", f"{path} ({path.stat().st_size // 1024} KB; {_probe(path)})"))
        except ModelFailure as e:
            failed += 1
            rows.append((mid, f"FAILED {e.code}", str(e), "-", "retry won't help" if not e.retryable else "may work on retry"))
        except Exception as e:  # noqa: BLE001
            failed += 1
            rows.append((mid, "FAILED", f"{type(e).__name__}: {str(e)[:150]}", "-", ""))
        finally:
            try:
                pipe.cleanup()
            except Exception:  # noqa: BLE001
                pass

    print("\n" + "=" * 78)
    for r in rows:
        print(f"{r[0]:<16} {r[1]:<14} {r[2]}\n{'':<16} peak GPU memory: {r[3]}   {r[4]}")
    print("=" * 78)
    print("Look at the videos, then tell me: which model looks best, and the render times above.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())
