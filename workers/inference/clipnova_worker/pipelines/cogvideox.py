"""CogVideoX-2B (Apache-2.0). Text-to-video, 720x480 landscape only, 8 fps. Runs on a small GPU (vendor-stated ~4GB+).

UNTESTED ON A GPU. Written against the diffusers CogVideoX docs and the official README (49 frames at 8 fps,
fp16 for the 2B model). It is the weakest-looking of the three, but the most permissive and the lightest.
Portrait is not offered: the model is trained at 720x480 and cropping it to portrait would discard most of the picture.
"""
from __future__ import annotations

from ..hardware import Hardware, detect
from . import _diffusers as d
from .base import Capability, GenerateRequest, ModelFailure, ProgressFn, VideoPipeline

REPO = "THUDM/CogVideoX-2b"
FRAMES = 49  # 8k+1, 6 s at 8 fps (official README)


class CogVideoX2B(VideoPipeline):
    capability = Capability(
        id="cogvideox-2b", name="CogVideoX-2B", modes=("t2v",), aspect_ratios=("16:9",), max_seconds=6.0, fps=8,
        sizes={"landscape": (720, 480)}, min_vram_gb=6.0, licence="apache-2.0",
        notes="landscape only; fixed 49 frames at 8 fps; prompts must be English",
    )

    def __init__(self, hw: Hardware | None = None) -> None:
        self.hw = hw or detect()
        self.pipe = None

    def load(self) -> None:
        import torch  # noqa: PLC0415
        from diffusers import CogVideoXPipeline  # noqa: PLC0415

        pipe = CogVideoXPipeline.from_pretrained(REPO, torch_dtype=torch.float16)  # 2B was trained in fp16
        pipe.enable_model_cpu_offload()
        pipe.vae.enable_tiling()
        self.pipe = pipe

    def generate(self, req: GenerateRequest, on_progress: ProgressFn) -> None:
        if self.pipe is None:
            self.load()
        steps = req.steps or 30
        try:
            out = self.pipe(  # type: ignore[misc]
                prompt=req.prompt, guidance_scale=6, num_inference_steps=steps, num_frames=FRAMES,
                generator=d.generator(req.seed), callback_on_step_end=d.step_callback(on_progress, steps),
            ).frames[0]
            d.export(out, req.out_path, self.capability.fps)
        except ModelFailure:
            raise
        except Exception as e:  # noqa: BLE001
            raise d.classify(e) from e
        finally:
            d.free_gpu()
