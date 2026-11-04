from clipnova_worker.hardware import Hardware
from clipnova_worker.registry import build_registry, fits, real_pipelines


def hw(vram, bf16=True):
    return Hardware("test-gpu", vram, bf16)


def test_models_are_offered_only_when_the_gpu_can_run_them():
    caps = {p.capability.id: p.capability for p in real_pipelines(None).values()}
    assert fits(caps["wan22-ti2v-5b"], hw(24))[0]
    assert not fits(caps["wan22-ti2v-5b"], hw(16))[0]              # too small
    assert not fits(caps["wan22-ti2v-5b"], hw(40, bf16=False))[0]  # needs bf16 (e.g. a T4 does not have it)
    assert fits(caps["ltx-video"], hw(16, bf16=False))[0]
    assert fits(caps["cogvideox-2b"], hw(16, bf16=False))[0]
    assert not fits(caps["cogvideox-2b"], None)[0]                 # no GPU at all


def test_a_t4_serves_only_the_light_models():
    r = build_registry(hw=hw(15, bf16=False))
    assert sorted(r) == ["cogvideox-2b", "ltx-video"]


def test_a_24gb_ampere_card_serves_everything():
    assert sorted(build_registry(hw=hw(24))) == ["cogvideox-2b", "ltx-video", "wan22-ti2v-5b"]


def test_no_gpu_serves_nothing_unless_fake():
    assert build_registry(hw=None, fake=False) == {}
    assert len(build_registry(fake=True)) == 3


def test_model_selection_by_name():
    assert sorted(build_registry(["ltx-video"], fake=True)) == ["ltx-video"]


def test_only_verified_modes_are_declared():
    # Image-to-video is not documented for Wan TI2V-5B in diffusers, and needs stored uploads for the others.
    for p in real_pipelines(None).values():
        assert p.capability.modes == ("t2v",), p.capability.id
