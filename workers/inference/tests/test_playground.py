import json
import subprocess

import pytest

from clipnova_worker.playground import PRESETS, Playground


def dims(path):
    j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)],
                                  capture_output=True, text=True, check=True).stdout)
    return j["streams"][0]["width"], j["streams"][0]["height"], float(j["format"]["duration"])


@pytest.fixture
def pg(tmp_path):
    return Playground(fake=True, out=str(tmp_path / "out"))


def test_a_prompt_becomes_a_real_video_and_is_remembered(pg, capsys):
    clip = pg.make("A cat rides a skateboard", seconds=1, seed=5)
    assert clip.path.exists() and dims(clip.path)[:2] == (512, 768)
    assert pg.history == [clip] and clip.seed == 5 and clip.prompt == "A cat rides a skateboard"
    second = pg.make("A robot waters plants", seconds=1)
    assert second.path != clip.path and len(pg.history) == 2
    assert "Loaded in" in capsys.readouterr().out
    # the model is loaded once, not for every prompt
    assert capsys.readouterr().out.count("Loaded in") == 0


def test_limits_are_applied_and_explained(pg, capsys):
    clip = pg.make("x" * 5, seconds=30, aspect="16:9")
    out = capsys.readouterr().out
    assert clip.seconds == 5.0 and "at most 5s" in out
    assert dims(clip.path)[:2] == (768, 512)            # landscape was honoured


@pytest.mark.parametrize("prompt,steps,message", [
    ("", 20, "Type a prompt"), ("   ", 20, "Type a prompt"), ("x" * 1501, 20, "limit"), ("ok", 2, "steps"), ("ok", 500, "steps"),
])
def test_bad_requests_are_refused_clearly(pg, prompt, steps, message):
    with pytest.raises(ValueError, match=message):
        pg.make(prompt, steps=steps)
    assert pg.history == []


def test_play_prints_instead_of_raising_and_a_model_failure_is_plain_english(pg, capsys):
    from clipnova_worker.pipelines.base import ModelFailure
    from clipnova_worker.pipelines.fake import FakePipeline

    assert pg.play("") is None
    assert "Type a prompt first." in capsys.readouterr().out
    pg.pipe = FakePipeline(pg.cap, fail_with=ModelFailure("OOM", "out of memory", retryable=False))
    assert pg.play("a cat") is None
    out = capsys.readouterr().out
    assert "could not make this clip (OOM)" in out and "shorter clip or fewer steps" in out
    pg.pipe = FakePipeline(pg.cap)
    assert pg.play("a cat", seconds=1) is not None
    assert "Done: 1s 9:16" in capsys.readouterr().out


def test_summary_lists_every_clip_for_sharing(pg):
    assert pg.summary() == "No clips yet."
    pg.make("first prompt here", seconds=1)
    pg.make("second prompt here", seconds=1)
    lines = pg.summary().splitlines()
    assert len(lines) == 2 and lines[0].startswith("1. 1s 9:16 20 steps") and "second prompt here" in lines[1]


def test_without_a_gpu_the_error_says_what_to_do(tmp_path):
    with pytest.raises(RuntimeError, match="Change runtime type"):
        Playground(out=str(tmp_path / "o"))


def test_the_starter_prompts_are_sensible():
    assert len(PRESETS) >= 5 and all(10 < len(p) < 400 for p in PRESETS)
