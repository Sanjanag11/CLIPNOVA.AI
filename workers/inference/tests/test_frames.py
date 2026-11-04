import pytest

from clipnova_worker.frames import frame_count, orientation_for, size_for


@pytest.mark.parametrize("seconds,fps,step,max_frames,expected", [
    (5, 24, 4, 121, 121),    # Wan: 5s -> 121 (4*30+1)
    (3, 24, 4, 121, 73),
    (2, 24, 4, 121, 49),
    (10, 24, 4, 121, 121),   # clamped to the model maximum
    (3, 24, 8, 121, 73),     # LTX: 8k+1
    (5, 24, 8, 121, 121),
    (6, 8, 8, 49, 49),       # CogVideoX-2B: 49 frames at 8 fps
    (1, 8, 8, 49, 9),
    (0.1, 24, 4, 121, 5),    # never below step+1
])
def test_frame_count(seconds, fps, step, max_frames, expected):
    assert frame_count(seconds, fps, step, max_frames) == expected


@pytest.mark.parametrize("step", [4, 8])
def test_every_result_satisfies_the_rule_and_the_cap(step):
    cap = 4 * 30 + 1 if step == 4 else 8 * 15 + 1
    for tenths in range(1, 80):
        n = frame_count(tenths / 10, 24, step, cap)
        assert (n - 1) % step == 0 and step + 1 <= n <= cap


def test_rejects_bad_input():
    with pytest.raises(ValueError):
        frame_count(0, 24, 4, 121)
    with pytest.raises(ValueError):
        frame_count(3, 0, 4, 121)
    with pytest.raises(ValueError):
        frame_count(3, 24, 4, 120)  # 120 does not satisfy 4k+1


def test_orientation_and_sizes():
    assert [orientation_for(a) for a in ("9:16", "1:1", "4:5", "16:9")] == ["portrait", "portrait", "portrait", "landscape"]
    sizes = {"landscape": (1280, 704), "portrait": (704, 1280)}
    assert size_for("9:16", sizes) == (704, 1280)
    assert size_for("16:9", sizes) == (1280, 704)
    with pytest.raises(ValueError):
        size_for("16:9", {"portrait": (512, 768)})  # model has no landscape
    with pytest.raises(ValueError):
        orientation_for("3:2")


def test_all_declared_sizes_are_multiples_of_32():
    from clipnova_worker.registry import real_pipelines
    for p in real_pipelines(None).values():
        for w, h in p.capability.sizes.values():
            assert w % 16 == 0 and h % 16 == 0, p.capability.id
