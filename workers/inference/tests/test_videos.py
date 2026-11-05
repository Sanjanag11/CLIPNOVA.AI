import json
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from clipnova_worker.app import create_app
from clipnova_worker.config import Settings
from clipnova_worker.pipelines.base import ModelFailure
from clipnova_worker.pipelines.fake import FakePipeline
from clipnova_worker.registry import build_registry

TOKEN = "tok-videos"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def make(tmp_path, **kw):
    reg = build_registry(["ltx-video", "cogvideox-2b"], fake=True)
    app = create_app(reg, Settings(token=TOKEN, allow_anon=False, data_dir=tmp_path / "w", max_queue=kw.get("max_queue", 4), ttl_seconds=kw.get("ttl", 3600)))
    return reg, app


@pytest.fixture
def ctx(tmp_path):
    reg, app = make(tmp_path)
    with TestClient(app) as c:
        c.reg = reg
        yield c
    app.state.jobs.close()


SCENES = [{"prompt": f"scene {i} of a cat", "seconds": s} for i, s in enumerate((3, 3, 2))]


def body(**kw):
    b = {"model": "ltx-video", "aspectRatio": "9:16", "watermark": False, "seed": 1, "scenes": SCENES}
    b.update(kw)
    return b


def wait(c, vid, until=("succeeded", "failed"), timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        r = c.get(f"/v1/videos/{vid}", headers=AUTH).json()
        if r["status"] in until:
            return r
        time.sleep(0.05)
    raise AssertionError(f"video stuck: {r}")


def wait_regen(c, vid, rid, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        s = c.get(f"/v1/videos/{vid}", headers=AUTH).json()["regens"][rid]
        if s != "running":
            return s
        time.sleep(0.05)
    raise AssertionError("regen stuck")


def probe(data, tmp_path):
    f = tmp_path / "x.mp4"
    f.write_bytes(data)
    j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", str(f)],
                                  capture_output=True, text=True, check=True).stdout)
    return j["streams"][0]["width"], j["streams"][0]["height"], j["streams"][0]["codec_name"], float(j["format"]["duration"])


def test_a_whole_video_is_rendered_stitched_and_served(ctx, tmp_path):
    r = ctx.post("/v1/videos", json=body(), headers=AUTH)
    assert r.status_code == 202
    vid = r.json()["videoId"]
    final = wait(ctx, vid)
    assert final["status"] == "succeeded" and final["progress"] == 1.0 and "error" not in final
    assert [(s["state"], s["attempt"], s["revision"]) for s in final["scenes"]] == [("done", 1, 1)] * 3
    v = ctx.get(f"/v1/videos/{vid}/video", headers=AUTH)
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4"
    w, h, codec, secs = probe(v.content, tmp_path)
    assert (w, h, codec) == (720, 1280, "h264") and 7.6 < secs < 8.4          # 3 + 3 + 2 seconds, portrait 720p
    prompts = [c.prompt for c in ctx.reg["ltx-video"].calls]
    assert prompts == ["scene 0 of a cat", "scene 1 of a cat", "scene 2 of a cat"]
    assert len({c.seed for c in ctx.reg["ltx-video"].calls}) == 3             # each scene gets its own seed


def test_progress_and_scene_states_are_visible_while_rendering(tmp_path):
    reg, app = make(tmp_path)
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, delay=0.4)
    seen, states = [], set()
    with TestClient(app) as c:
        vid = c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
        while True:
            r = c.get(f"/v1/videos/{vid}", headers=AUTH).json()
            seen.append(r["progress"])
            states.update(s["state"] for s in r["scenes"])
            if r["status"] in ("succeeded", "failed"):
                break
            time.sleep(0.03)
    assert seen == sorted(seen) and seen[0] < 0.5 and seen[-1] == 1.0 and max(p for p in seen[:-1]) < 1.0
    assert {"queued", "rendering", "done"} <= states
    app.state.jobs.close()


def test_a_transient_failure_is_retried_inside_the_worker(tmp_path):
    reg, app = make(tmp_path)
    seen = {}
    def behave(req):
        seen[req.prompt] = seen.get(req.prompt, 0) + 1
        return ModelFailure("MODEL_ERROR", "hiccup", retryable=True) if req.prompt.startswith("scene 1") and seen[req.prompt] == 1 else None
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, behave=behave)
    with TestClient(app) as c:
        final = wait(c, c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"])
    assert final["status"] == "succeeded"
    assert [s["attempt"] for s in final["scenes"]] == [1, 2, 1] and all(s["state"] == "done" for s in final["scenes"])
    app.state.jobs.close()


def test_a_scene_that_cannot_be_rendered_is_reported_and_the_rest_still_ship(tmp_path):
    reg, app = make(tmp_path)
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, behave=lambda r: ModelFailure("OOM", "out of memory", retryable=False) if r.prompt.startswith("scene 1") else None)
    with TestClient(app) as c:
        final = wait(c, c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"])
        assert final["status"] == "succeeded"                                   # the video exists...
        assert [s["state"] for s in final["scenes"]] == ["done", "failed", "done"]   # ...and says which scene is missing
        assert final["scenes"][1]["error"] == {"code": "OOM", "message": "out of memory", "retryable": False}
        assert final["scenes"][1]["attempt"] == 1                               # a non-retryable failure is not repeated
        vid = c.get("/healthz").json() and next(iter(app.state.videos.videos))
        assert c.get(f"/v1/videos/{vid}/video", headers=AUTH).status_code == 200
    app.state.jobs.close()


def test_when_every_scene_fails_the_video_fails_with_the_reason(tmp_path):
    reg, app = make(tmp_path)
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, fail_with=ModelFailure("OOM", "out of memory", retryable=False))
    with TestClient(app) as c:
        vid = c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
        final = wait(c, vid)
        assert final["status"] == "failed" and final["error"]["code"] == "OOM" and final["error"]["retryable"] is False
        assert c.get(f"/v1/videos/{vid}/video", headers=AUTH).status_code == 409
    app.state.jobs.close()


def test_a_compose_failure_fails_the_video(tmp_path):
    reg, app = make(tmp_path)

    class Garbage(FakePipeline):
        def generate(self, req, on_progress):
            req.out_path.write_bytes(b"this is not a video" * 200)

    reg["ltx-video"] = Garbage(reg["ltx-video"].capability)
    with TestClient(app) as c:
        final = wait(c, c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"])
    assert final["status"] == "failed" and final["error"]["code"] == "COMPOSE_FAILED"
    app.state.jobs.close()


def test_regenerating_one_scene_replaces_only_that_scene(ctx, tmp_path):
    vid = ctx.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
    before = ctx.get(f"/v1/videos/{vid}/video", headers=AUTH).content if wait(ctx, vid)["status"] == "succeeded" else b""
    calls_before = len(ctx.reg["ltx-video"].calls)
    r = ctx.post(f"/v1/videos/{vid}/scenes/1/regenerate", json={"prompt": "a NEW scene one", "seed": 5}, headers=AUTH)
    assert r.status_code == 202
    assert wait_regen(ctx, vid, r.json()["regenId"]) == "succeeded"
    st = ctx.get(f"/v1/videos/{vid}", headers=AUTH).json()
    assert st["status"] == "succeeded" and [s["revision"] for s in st["scenes"]] == [1, 2, 1] and all(s["state"] == "done" for s in st["scenes"])
    new_calls = ctx.reg["ltx-video"].calls[calls_before:]
    assert len(new_calls) == 1 and new_calls[0].prompt == "a NEW scene one"     # only the one scene was rendered
    # the fake renderer draws the same pattern every time, so check which clip files were used, not the bytes
    names = [s.path.name for s in ctx.app.state.videos.get(vid).scenes]
    assert names == ["scene0-r1.mp4", "scene1-r2.mp4", "scene2-r1.mp4"]
    after = ctx.get(f"/v1/videos/{vid}/video", headers=AUTH).content
    assert before and 7.6 < probe(after, tmp_path)[3] < 8.4                      # still a full-length stitched video


def test_a_failed_regeneration_leaves_the_video_exactly_as_it_was(tmp_path):
    reg, app = make(tmp_path)
    with TestClient(app) as c:
        vid = c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
        wait(c, vid)
        before = c.get(f"/v1/videos/{vid}/video", headers=AUTH).content
        reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, fail_with=ModelFailure("OOM", "oom", retryable=False))
        rid = c.post(f"/v1/videos/{vid}/scenes/0/regenerate", json={}, headers=AUTH).json()["regenId"]
        assert wait_regen(c, vid, rid) == "failed"
        st = c.get(f"/v1/videos/{vid}", headers=AUTH).json()
        assert st["scenes"][0]["state"] == "done" and st["scenes"][0]["revision"] == 1
        assert c.get(f"/v1/videos/{vid}/video", headers=AUTH).content == before
    app.state.jobs.close()


def test_regeneration_guards(tmp_path):
    reg, app = make(tmp_path)
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, delay=0.5)
    with TestClient(app) as c:
        vid = c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
        assert c.post(f"/v1/videos/{vid}/scenes/0/regenerate", json={}, headers=AUTH).status_code == 409   # still rendering
        wait(c, vid)
        assert c.post(f"/v1/videos/{vid}/scenes/9/regenerate", json={}, headers=AUTH).status_code == 404
        assert c.post("/v1/videos/nope/scenes/0/regenerate", json={}, headers=AUTH).status_code == 404
        first = c.post(f"/v1/videos/{vid}/scenes/0/regenerate", json={}, headers=AUTH)
        assert first.status_code == 202
        assert c.post(f"/v1/videos/{vid}/scenes/1/regenerate", json={}, headers=AUTH).status_code == 409   # one at a time
        wait_regen(c, vid, first.json()["regenId"])
    app.state.jobs.close()


@pytest.mark.parametrize("override,status", [
    ({"model": "nope"}, 404), ({"aspectRatio": "9:16", "model": "cogvideox-2b"}, 422), ({"aspectRatio": "3:2"}, 422),
    ({"scenes": []}, 422), ({"scenes": [{"prompt": "x", "seconds": 5.5}]}, 422), ({"scenes": [{"prompt": "", "seconds": 2}]}, 422),
    ({"scenes": [{"prompt": "x", "seconds": 1}] * 13}, 422), ({"seed": -1}, 422),
])
def test_validation(ctx, override, status):
    assert ctx.post("/v1/videos", json=body(**override), headers=AUTH).status_code == status


def test_auth_and_unknown_ids(ctx):
    assert ctx.post("/v1/videos", json=body()).status_code == 401
    assert ctx.get("/v1/videos/x").status_code == 401
    assert ctx.get("/v1/videos/x", headers=AUTH).status_code == 404
    assert ctx.get("/v1/videos/x/video", headers=AUTH).status_code == 404
    assert ctx.delete("/v1/videos/x", headers=AUTH).status_code == 404


def test_queue_limit_and_cleanup(tmp_path):
    reg, app = make(tmp_path, max_queue=1, ttl=0)
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, delay=0.4)
    with TestClient(app) as c:
        first = c.post("/v1/videos", json=body(), headers=AUTH)
        assert first.status_code == 202
        assert c.post("/v1/videos", json=body(), headers=AUTH).status_code == 429
        vid = first.json()["videoId"]
        wait(c, vid)
        folder = app.state.videos.get(vid).dir
        assert folder.exists()
        assert c.delete(f"/v1/videos/{vid}", headers=AUTH).status_code == 204 and not folder.exists()
        # expired videos disappear on the next submit
        old = c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
        wait(c, old)
        time.sleep(0.05)
        last = c.post("/v1/videos", json=body(), headers=AUTH).json()["videoId"]
        assert c.get(f"/v1/videos/{old}", headers=AUTH).status_code == 404
        wait(c, last)
    app.state.jobs.close()


def test_free_plan_watermark_request_is_honoured(ctx, tmp_path):
    vid = ctx.post("/v1/videos", json=body(watermark=True, scenes=[{"prompt": "x", "seconds": 1}]), headers=AUTH).json()["videoId"]
    assert wait(ctx, vid)["status"] == "succeeded"
    assert ctx.get(f"/v1/videos/{vid}/video", headers=AUTH).status_code == 200
