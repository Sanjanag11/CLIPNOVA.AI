import json
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from clipnova_worker.app import create_app
from clipnova_worker.config import Settings
from clipnova_worker.pipelines.base import ModelFailure
from clipnova_worker.pipelines.fake import FakePipeline
from clipnova_worker.registry import build_registry

TOKEN = "secret-token-123"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def settings(tmp_path, **kw):
    base = dict(token=TOKEN, allow_anon=False, data_dir=tmp_path / "jobs", max_queue=8, ttl_seconds=3600)
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def client(tmp_path):
    reg = build_registry(fake=True)
    app = create_app(reg, settings(tmp_path))
    with TestClient(app) as c:
        c.registry = reg
        yield c
    app.state.jobs.close()


def body(**kw):
    b = {"model": "ltx-video", "prompt": "a cat on a skateboard", "seconds": 2, "aspectRatio": "9:16", "seed": 7}
    b.update(kw)
    return b


def wait(c, jid, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        r = c.get(f"/v1/jobs/{jid}", headers=AUTH).json()
        if r["status"] in ("succeeded", "failed"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,codec_name,r_frame_rate:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    return j["streams"][0], float(j["format"]["duration"])


def test_refuses_to_start_without_a_token_unless_explicitly_anonymous(tmp_path):
    with pytest.raises(RuntimeError, match="WORKER_TOKEN"):
        create_app(build_registry(fake=True), settings(tmp_path, token=None))
    create_app(build_registry(fake=True), settings(tmp_path, token=None, allow_anon=True))  # local dev is allowed


def test_authentication(client):
    assert client.get("/healthz").json() == {"ok": True}            # open, reveals nothing
    for path in ("/v1/models", "/v1/jobs/x", "/v1/jobs/x/video"):
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get(path, headers={"Authorization": TOKEN}).status_code == 401              # the scheme is required
        assert client.get(path, headers={"Authorization": f"Basic {TOKEN}"}).status_code == 401
    assert client.post("/v1/jobs", json=body()).status_code == 401
    assert client.get("/v1/models", headers={"Authorization": f"bearer {TOKEN}"}).status_code == 200  # scheme is case-insensitive


def test_models_endpoint_reports_capabilities(client):
    r = client.get("/v1/models", headers=AUTH)
    assert r.status_code == 200
    by_id = {m["id"]: m for m in r.json()["models"]}
    assert set(by_id) == {"wan22-ti2v-5b", "ltx-video", "cogvideox-2b"}
    assert by_id["cogvideox-2b"]["aspectRatios"] == ["16:9"] and by_id["cogvideox-2b"]["fps"] == 8
    assert by_id["ltx-video"]["sizes"]["portrait"] == [512, 768]
    assert all(m["modes"] == ["t2v"] for m in by_id.values())


def test_full_job_lifecycle_returns_a_real_video(client, tmp_path):
    r = client.post("/v1/jobs", json=body(seconds=2), headers=AUTH)
    assert r.status_code == 202
    jid = r.json()["jobId"]
    final = wait(client, jid)
    assert final["status"] == "succeeded" and final["progress"] == 1.0 and "gpuSeconds" in final and "error" not in final
    v = client.get(f"/v1/jobs/{jid}/video", headers=AUTH)
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4"
    f = tmp_path / "out.mp4"
    f.write_bytes(v.content)
    stream, seconds = probe(f)
    assert (stream["width"], stream["height"], stream["codec_name"]) == (512, 768, "h264")
    assert 1.8 < seconds < 2.3


def test_landscape_request_gets_a_landscape_video(client, tmp_path):
    jid = client.post("/v1/jobs", json=body(aspectRatio="16:9", seconds=1), headers=AUTH).json()["jobId"]
    wait(client, jid)
    f = tmp_path / "l.mp4"
    f.write_bytes(client.get(f"/v1/jobs/{jid}/video", headers=AUTH).content)
    stream, _ = probe(f)
    assert (stream["width"], stream["height"]) == (768, 512)


def test_the_pipeline_receives_exactly_what_was_asked(client):
    jid = client.post("/v1/jobs", json=body(prompt="hello world", negativePrompt="blurry", seconds=1, seed=99, steps=12), headers=AUTH).json()["jobId"]
    wait(client, jid)
    req = client.registry["ltx-video"].calls[-1]
    assert (req.prompt, req.negative_prompt, req.seconds, req.aspect_ratio, req.seed, req.steps) == ("hello world", "blurry", 1, "9:16", 99, 12)


@pytest.mark.parametrize("override,status", [
    ({"model": "nope"}, 404),
    ({"aspectRatio": "9:16", "model": "cogvideox-2b"}, 422),   # Cog is landscape only
    ({"seconds": 5.5}, 422),                                   # more than LTX renders per clip
    ({"seconds": 0}, 422),
    ({"seconds": -1}, 422),
    ({"prompt": ""}, 422),
    ({"prompt": "x" * 2001}, 422),
    ({"aspectRatio": "3:2"}, 422),
    ({"seed": -1}, 422),
    ({"steps": 1}, 422),
])
def test_validation(client, override, status):
    assert client.post("/v1/jobs", json=body(**override), headers=AUTH).status_code == status


def test_unknown_and_not_ready_jobs(client):
    assert client.get("/v1/jobs/doesnotexist", headers=AUTH).status_code == 404
    assert client.get("/v1/jobs/doesnotexist/video", headers=AUTH).status_code == 404
    # a job that has not finished has no video yet
    slow = FakePipeline(client.registry["ltx-video"].capability, delay=0.6)
    client.registry["ltx-video"] = slow
    jid = client.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"]
    assert client.get(f"/v1/jobs/{jid}/video", headers=AUTH).status_code == 409
    wait(client, jid)


@pytest.mark.parametrize("failure,code,retryable", [
    (ModelFailure("OOM", "the GPU ran out of memory", retryable=False), "OOM", False),
    (ModelFailure("MODEL_ERROR", "boom", retryable=True), "MODEL_ERROR", True),
])
def test_classified_failures_reach_the_client(client, failure, code, retryable):
    client.registry["ltx-video"] = FakePipeline(client.registry["ltx-video"].capability, fail_with=failure)
    final = wait(client, client.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"])
    assert final["status"] == "failed"
    assert final["error"]["code"] == code and final["error"]["retryable"] is retryable and final["error"]["message"]
    assert "gpuSeconds" in final


def test_an_unexpected_crash_fails_the_job_but_not_the_worker(client):
    class Crashy(FakePipeline):
        def generate(self, req, on_progress):
            raise ZeroDivisionError("bug")

    client.registry["ltx-video"] = Crashy(client.registry["ltx-video"].capability)
    final = wait(client, client.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"])
    assert final["status"] == "failed" and final["error"]["code"] == "MODEL_ERROR" and final["error"]["retryable"] is True
    assert "ZeroDivisionError" in final["error"]["message"]
    # the worker still serves the next job
    client.registry["ltx-video"] = FakePipeline(client.registry["ltx-video"].capability)
    assert wait(client, client.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"])["status"] == "succeeded"


def test_a_model_that_writes_nothing_is_a_failure(client):
    class Silent(FakePipeline):
        def generate(self, req, on_progress):
            on_progress(0.9)

    client.registry["ltx-video"] = Silent(client.registry["ltx-video"].capability)
    final = wait(client, client.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"])
    assert final["status"] == "failed" and final["error"]["code"] == "EMPTY_OUTPUT"


def test_queue_limit_returns_429_and_one_job_runs_at_a_time(tmp_path):
    reg = build_registry(fake=True)
    order = []

    class Tracked(FakePipeline):
        def generate(self, req, on_progress):
            order.append(("start", req.seed))
            super().generate(req, on_progress)
            order.append(("end", req.seed))

    reg["ltx-video"] = Tracked(reg["ltx-video"].capability, delay=0.3)
    app = create_app(reg, settings(tmp_path, max_queue=2))
    with TestClient(app) as c:
        ids = [c.post("/v1/jobs", json=body(seconds=1, seed=s), headers=AUTH) for s in (1, 2)]
        assert [r.status_code for r in ids] == [202, 202]
        assert c.post("/v1/jobs", json=body(seconds=1, seed=3), headers=AUTH).status_code == 429
        for r in ids:
            wait(c, r.json()["jobId"])
        # a free slot again once the queue drains
        assert c.post("/v1/jobs", json=body(seconds=1, seed=4), headers=AUTH).status_code == 202
    # strictly sequential: never two running at once
    assert order[:4] == [("start", 1), ("end", 1), ("start", 2), ("end", 2)]
    app.state.jobs.close()


def test_progress_is_monotonic_and_reaches_one(tmp_path):
    reg = build_registry(fake=True)
    reg["ltx-video"] = FakePipeline(reg["ltx-video"].capability, delay=0.4)
    app = create_app(reg, settings(tmp_path))
    seen = []
    with TestClient(app) as c:
        jid = c.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"]
        while True:
            r = c.get(f"/v1/jobs/{jid}", headers=AUTH).json()
            seen.append(r["progress"])
            if r["status"] != "running" and r["status"] != "queued":
                break
            time.sleep(0.03)
    assert seen == sorted(seen) and seen[-1] == 1.0 and any(0 < p < 1 for p in seen)
    app.state.jobs.close()


def test_delete_and_ttl_cleanup(tmp_path):
    reg = build_registry(fake=True)
    app = create_app(reg, settings(tmp_path, ttl_seconds=0))
    with TestClient(app) as c:
        jid = c.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"]
        wait(c, jid)
        path = Path(app.state.jobs.get(jid).request.out_path)
        assert path.exists()
        assert c.delete(f"/v1/jobs/{jid}", headers=AUTH).status_code == 204
        assert not path.exists() and c.get(f"/v1/jobs/{jid}", headers=AUTH).status_code == 404
        assert c.delete(f"/v1/jobs/{jid}", headers=AUTH).status_code == 404
        # expired jobs disappear the next time a job is submitted
        old = c.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"]
        wait(c, old)
        time.sleep(0.05)
        last = c.post("/v1/jobs", json=body(seconds=1), headers=AUTH).json()["jobId"]
        assert c.get(f"/v1/jobs/{old}", headers=AUTH).status_code == 404
        wait(c, last)
    app.state.jobs.close()
