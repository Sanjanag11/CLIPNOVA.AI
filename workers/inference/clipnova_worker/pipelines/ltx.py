"""LTX-Video (Lightricks). Text-to-video. The smallest of the three; the one that fits a 16GB card.

UNTESTED ON A GPU. Written against the diffusers LTX docs (LTXPipeline, 768x512 example, 8k+1 frames, 24 fps,
decode_timestep/decode_noise_scale). Image-to-video via LTXConditionPipeline is documented but needs an input
image, which the app cannot store yet, so only t2v is offered.

LICENCE (read on Hugging Face, 6 Nov 2026): the top-level checkpoint loaded here is an OLDER v0.9.x model (RAIL-M); v0.9.6+ are under the
"LTXV Open Weights License 0.X" (free below $10M annual revenue, AI-generated content must be disclosed, use restrictions must be passed to users).
Newer, better checkpoints exist in the same repo (e.g. ltxv-2b-0.9.8-distilled) but loading them is untested. See docs/open-source-stack.md.
"""
from __future__ import annotations

from ..frames import frame_count, size_for
from ..hardware import Hardware, detect
from . import _diffusers as d
from .base import Capability, GenerateRequest, ModelFailure, ProgressFn, VideoPipeline

REPO = "Lightricks/LTX-Video"
MAX_FRAMES = 121  # 8*15+1 -> about 5 s at 24 fps


class LTXVideo(VideoPipeline):
    capability = Capability(
        id="ltx-video", name="LTX-Video", modes=("t2v",),
        aspect_ratios=("9:16", "16:9", "1:1", "4:5"), max_seconds=5.0, fps=24,
        sizes={"landscape": (768, 512), "portrait": (512, 768)},
        min_vram_gb=12.0, licence="ltxv-open-weights-0.x",
        notes="loads an older v0.9.x checkpoint; see docs/open-source-stack.md for licence terms; doc example size 768x512",
    )

    def __init__(self, hw: Hardware | None = None) -> None:
        self.hw = hw or detect()
        self.pipe = None

    def load(self) -> None:
        from diffusers import LTXPipeline  # noqa: PLC0415

        pipe = LTXPipeline.from_pretrained(REPO, torch_dtype=d.pick_dtype(self.hw))
        if self.hw and self.hw.vram_gb >= 24:
            pipe.to("cuda")
        else:
            pipe.enable_model_cpu_offload()
        pipe.vae.enable_tiling()
        self.pipe = pipe

    def generate(self, req: GenerateRequest, on_progress: ProgressFn) -> None:
        if self.pipe is None:
            self.load()
        w, h = size_for(req.aspect_ratio, self.capability.sizes)
        steps = req.steps or 30
        try:
            out = self.pipe(  # type: ignore[misc]
                prompt=req.prompt,
                negative_prompt=req.negative_prompt or "worst quality, inconsistent motion, blurry, jittery, distorted",
                width=w, height=h, num_frames=frame_count(req.seconds, self.capability.fps, 8, MAX_FRAMES),
                decode_timestep=0.03, decode_noise_scale=0.025, num_inference_steps=steps,
                generator=d.generator(req.seed), callback_on_step_end=d.step_callback(on_progress, steps),
            ).frames[0]
            d.export(out, req.out_path, self.capability.fps)
        except ModelFailure:
            raise
        except Exception as e:  # noqa: BLE001
            raise d.classify(e) from e
        finally:
            d.free_gpu()
