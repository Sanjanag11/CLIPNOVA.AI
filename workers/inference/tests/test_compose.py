import json
import subprocess
from pathlib import Path

import pytest

from clipnova_worker import compose as C


def clip(path: Path, seconds, w, h, fps):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}:duration={seconds}",
                    "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def probe(path):
    j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,pix_fmt,r_frame_rate:format=duration",
                                   "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout)
    s = j["streams"][0]
    n, d = (int(x) for x in s["r_frame_rate"].split("/"))
    return s["width"], s["height"], s["codec_name"], s["pix_fmt"], n / d, float(j["format"]["duration"])


@pytest.mark.parametrize("aspect", ["9:16", "16:9", "1:1", "4:5"])
def test_scenes_of_different_sizes_and_fps_become_one_h264_video(tmp_path, aspect):
    a = clip(tmp_path / "a.mp4", 2, 512, 768, 24)
    b = clip(tmp_path / "b.mp4", 2, 720, 480, 8)       # landscape, 8 fps, like CogVideoX
    out = tmp_path / "o.mp4"
    C.compose([a, b], out, aspect, watermark=False)
    w, h, codec, pix, fps, secs = probe(out)
    assert (w, h) == C.OUTPUT_SIZE[aspect] and codec == "h264" and pix == "yuv420p" and fps == 24
    assert 3.8 < secs < 4.3


def test_single_scene_and_no_leftover_temp_file(tmp_path):
    out = tmp_path / "o.mp4"
    C.compose([clip(tmp_path / "a.mp4", 1, 320, 240, 24)], out, "9:16", False)
    assert probe(out)[5] > 0.8
    assert not list(tmp_path.glob("*.tmp.mp4"))


def _corner(path, crop):
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-frames:v", "1", "-vf", f"crop={crop}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                          capture_output=True, check=True).stdout


def test_watermark_is_stamped_only_when_asked_and_only_in_the_corner(tmp_path):
    src = clip(tmp_path / "a.mp4", 1, 640, 360, 24)
    plain, marked = tmp_path / "p.mp4", tmp_path / "m.mp4"
    C.compose([src], plain, "16:9", False)
    C.compose([src], marked, "16:9", True)
    a, b = _corner(plain, "260:70:iw-260:ih-70"), _corner(marked, "260:70:iw-260:ih-70")
    assert sum(abs(x - y) > 20 for x, y in zip(a, b)) > 200
    ta, tb = _corner(plain, "200:60:0:0"), _corner(marked, "200:60:0:0")
    assert sum(abs(x - y) > 20 for x, y in zip(ta, tb)) < len(ta) * 0.02


def test_failures_are_clear(tmp_path, monkeypatch):
    with pytest.raises(C.ComposeError, match="no scenes"):
        C.compose([], tmp_path / "o.mp4", "9:16", False)
    with pytest.raises(C.ComposeError, match="unsupported aspect"):
        C.compose([tmp_path / "x.mp4"], tmp_path / "o.mp4", "3:2", False)
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video" * 100)
    with pytest.raises(C.ComposeError, match="ffmpeg failed"):
        C.compose([bad], tmp_path / "o.mp4", "9:16", False)
    assert not (tmp_path / "o.mp4").exists()
    # a free-plan video must never be produced without its watermark
    monkeypatch.setattr(C, "FONT_CANDIDATES", [])
    with pytest.raises(C.ComposeError, match="no font"):
        C.compose([clip(tmp_path / "a.mp4", 1, 320, 240, 24)], tmp_path / "o.mp4", "9:16", True)


def test_arguments_are_a_list_with_one_filter_graph():
    args = C.build_args([Path("/a.mp4"), Path("/b.mp4")], Path("/o.mp4"), "9:16", True, "/f.ttf")
    assert isinstance(args, list) and args[0] == "ffmpeg" and args[-1] == "/o.mp4"
    graph = args[args.index("-filter_complex") + 1]
    assert "concat=n=2:v=1:a=0" in graph and "drawtext=fontfile=/f.ttf:text='ClipNova.ai'" in graph
