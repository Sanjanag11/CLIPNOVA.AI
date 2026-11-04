"""Wan 2.2 TI2V-5B (Apache-2.0). Text-to-video only.

UNTESTED ON A GPU. Written against the diffusers Wan docs (WanPipeline, float32 VAE, group/CPU offload, 4k+1 frames).
Image-to-video for this checkpoint is NOT documented in diffusers, so it is deliberately not offered:
modes stays ("t2v",) until someone verifies it on hardware.
"""
from __future__ import annotations

from ..frames import frame_count, size_for
from ..hardware import Hardware, detect
from . import _diffusers as d
from .base import Capability, GenerateRequest, ModelFailure, ProgressFn, VideoPipeline

REPO = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"
MAX_FRAMES = 121  # 5 s at 24 fps (vendor-stated)


class Wan22TI2V5B(VideoPipeline):
    capability = Capability(
        id="wan22-ti2v-5b", name="Wan 2.2 TI2V-5B", modes=("t2v",),
        aspect_ratios=("9:16", "16:9", "1:1", "4:5"), max_seconds=5.0, fps=24,
        # Official size is 1280x704. A lighter size is used when the GPU is small (see _sizes).
        sizes={"landscape": (1280, 704), "portrait": (704, 1280)},
        min_vram_gb=24.0, needs_bf16=True, licence="apache-2.0",
        notes="vendor-stated: >=24GB; bf16 GPU (Ampere or newer) required; image input not enabled",
    )

    def __init__(self, hw: Hardware | None = None) -> None:
        self.hw = hw or detect()
        self.pipe = None

    def load(self) -> None:
        import torch  # noqa: PLC0415
        from diffusers import AutoModel, WanPipeline  # noqa: PLC0415

        vae = AutoModel.from_pretrained(REPO, subfolder="vae", torch_dtype=torch.float32)  # fp32 VAE decodes better
        pipe = WanPipeline.from_pretrained(REPO, vae=vae, torch_dtype=torch.bfloat16)
        if self.hw and self.hw.vram_gb >= 40:
            pipe.to("cuda")
        else:
            pipe.enable_model_cpu_offload()
        self.pipe = pipe

    def generate(self, req: GenerateRequest, on_progress: ProgressFn) -> None:
        if self.pipe is None:
            self.load()
        w, h = size_for(req.aspect_ratio, self.capability.sizes)
        steps = req.steps or 30
        try:
            out = self.pipe(  # type: ignore[misc]
                prompt=req.prompt, negative_prompt=req.negative_prompt, width=w, height=h,
                num_frames=frame_count(req.seconds, self.capability.fps, 4, MAX_FRAMES),
                num_inference_steps=steps, guidance_scale=5.0, generator=d.generator(req.seed),
                callback_on_step_end=d.step_callback(on_progress, steps),
            ).frames[0]
            d.export(out, req.out_path, self.capability.fps)
        except ModelFailure:
            raise
        except Exception as e:  # noqa: BLE001
            raise d.classify(e) from e
        finally:
            d.free_gpu()
