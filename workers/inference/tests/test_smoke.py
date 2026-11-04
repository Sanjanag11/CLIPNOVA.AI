import json
import subprocess

from clipnova_worker.smoke import run


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    return j["streams"][0]["width"], j["streams"][0]["height"], float(j["format"]["duration"])


def test_fake_run_tests_every_model_and_writes_real_videos(tmp_path, capsys):
    assert run(["--fake", "--out", str(tmp_path), "--seconds", "1"]) == 0
    text = capsys.readouterr().out
    for mid in ("wan22-ti2v-5b", "ltx-video", "cogvideox-2b"):
        assert (tmp_path / f"{mid}.mp4").stat().st_size > 1000
        assert mid in text
    assert (probe(tmp_path / "ltx-video.mp4")[:2]) == (512, 768)
    # CogVideoX is landscape-only, so a portrait request is adjusted and says so
    assert "[cogvideox-2b] adjusted to 1.0s, 16:9" in text
    assert probe(tmp_path / "cogvideox-2b.mp4")[:2] == (720, 480)


def test_model_selection_and_limits(tmp_path, capsys):
    assert run(["--fake", "--model", "ltx-video", "--seconds", "30", "--out", str(tmp_path)]) == 0
    text = capsys.readouterr().out
    assert "adjusted to 5.0s" in text            # clamped to the model's maximum
    assert (tmp_path / "ltx-video.mp4").exists() and not (tmp_path / "wan22-ti2v-5b.mp4").exists()


def test_without_a_gpu_it_says_what_to_do_and_exits_nonzero(tmp_path, capsys):
    assert run(["--out", str(tmp_path)]) == 2
    text = capsys.readouterr().out
    assert "switch the runtime to a GPU" in text and "does not fit this GPU" in text
