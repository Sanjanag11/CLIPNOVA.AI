"""Whole-video jobs: render every scene (with retries), stitch them, and regenerate single scenes.

The web app runs on short-lived serverless functions, so it cannot wait for a GPU. It hands the worker a complete
video job and polls. One GPU thread runs everything, so a video's scenes are rendered back to back.
"""
from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .compose import ComposeError, compose
from .jobs import QueueFull
from .pipelines.base import GenerateRequest, ModelFailure, VideoPipeline


@dataclass
class Scene:
    index: int
    prompt: str
    seconds: float
    state: str = "queued"          # queued | rendering | retrying | done | failed
    progress: float = 0.0
    attempt: int = 0
    revision: int = 0              # bumped every time a new clip replaces the old one
    error: dict | None = None
    path: Path | None = None


@dataclass
class Video:
    id: str
    model: str
    aspect: str
    watermark: bool
    seed: int
    steps: int | None
    scenes: list[Scene]
    dir: Path
    status: str = "queued"         # queued | running | composing | succeeded | failed
    error: dict | None = None
    gpu_seconds: float = 0.0
    regens: dict[str, str] = field(default_factory=dict)   # regenId -> running | succeeded | failed
    finished: float | None = None
    created: float = field(default_factory=time.time)

    @property
    def out_path(self) -> Path:
        return self.dir / "final.mp4"

    @property
    def progress(self) -> float:
        if self.status == "succeeded" or self.status == "failed":
            return 1.0
        done = sum(1.0 if s.state in ("done", "failed") else s.progress for s in self.scenes) / max(1, len(self.scenes))
        return round(min(0.98, 0.05 + 0.9 * done) if self.status != "queued" else 0.0, 3)


class VideoManager:
    def __init__(self, registry: dict[str, VideoPipeline], data_dir: Path, pool: ThreadPoolExecutor, max_active: int = 4,
                 ttl_seconds: int = 3600, max_attempts: int = 2) -> None:
        self.registry = registry
        self.dir = data_dir / "videos"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.pool = pool
        self.max_active = max_active
        self.ttl = ttl_seconds
        self.max_attempts = max_attempts
        self.videos: dict[str, Video] = {}
        self._lock = threading.Lock()

    # ---- submit -------------------------------------------------------------------------------------------------
    def submit(self, model: str, aspect: str, watermark: bool, seed: int, steps: int | None, scenes: list[tuple[str, float]]) -> Video:
        self._cleanup()
        with self._lock:
            if sum(1 for v in self.videos.values() if v.status in ("queued", "running", "composing")) >= self.max_active:
                raise QueueFull()
            vid = uuid.uuid4().hex
            d = self.dir / vid
            d.mkdir(parents=True)
            video = Video(vid, model, aspect, watermark, seed, steps, [Scene(i, p, s) for i, (p, s) in enumerate(scenes)], d)
            self.videos[vid] = video
        self.pool.submit(self._run, video)
        return video

    # ---- rendering ----------------------------------------------------------------------------------------------
    def _render(self, v: Video, scene: Scene, extra_seed: int = 0) -> bool:
        """Renders one scene with retries. Returns True on success; leaves the scene's error set on failure."""
        pipe = self.registry[v.model]
        path = v.dir / f"scene{scene.index}-r{scene.revision + 1}.mp4"
        for attempt in range(1, self.max_attempts + 1):
            scene.attempt = attempt
            scene.state, scene.progress, scene.error = "rendering", 0.0, None
            try:
                pipe.generate(GenerateRequest(scene.prompt, "", scene.seconds, v.aspect, v.seed + scene.index * 1000 + extra_seed + attempt, v.steps, path),
                              lambda p: setattr(scene, "progress", max(scene.progress, min(0.99, p))))
                if not path.exists() or path.stat().st_size < 1024:
                    raise ModelFailure("EMPTY_OUTPUT", "the model produced no video", retryable=True)
                scene.state, scene.progress = "done", 1.0
                return True
            except ModelFailure as e:
                scene.error = {"code": e.code, "message": str(e), "retryable": e.retryable}
            except Exception as e:  # noqa: BLE001 - a crashed scene must never take the worker down
                scene.error = {"code": "MODEL_ERROR", "message": f"{type(e).__name__}: {str(e)[:200]}", "retryable": True}
            finally:
                try:
                    pipe.cleanup()
                except Exception:  # noqa: BLE001
                    pass
            if not scene.error["retryable"] or attempt == self.max_attempts:
                break
            scene.state, scene.progress = "retrying", 0.0
        scene.state, scene.progress = "failed", 0.0
        return False

    def _compose(self, v: Video, scenes: list[Scene]) -> None:
        compose([s.path for s in scenes if s.path], v.out_path, v.aspect, v.watermark)

    def _run(self, v: Video) -> None:
        started = time.time()
        v.status = "running"
        try:
            for scene in v.scenes:
                scene.path = v.dir / f"scene{scene.index}-r{scene.revision + 1}.mp4"
                if self._render(v, scene):
                    scene.revision += 1
                else:
                    scene.path = None
            ok = [s for s in v.scenes if s.state == "done"]
            if not ok:
                first = next(s.error for s in v.scenes if s.error)
                v.status, v.error = "failed", first
                return
            v.status = "composing"
            try:
                self._compose(v, ok)
            except ComposeError as e:
                v.status, v.error = "failed", {"code": "COMPOSE_FAILED", "message": str(e), "retryable": True}
                return
            v.status = "succeeded"
        except Exception as e:  # noqa: BLE001
            v.status, v.error = "failed", {"code": "INTERNAL", "message": f"{type(e).__name__}: {str(e)[:200]}", "retryable": True}
        finally:
            v.gpu_seconds = round(time.time() - started, 2)
            v.finished = time.time()

    # ---- single-scene regeneration -------------------------------------------------------------------------------
    def regenerate(self, vid: str, index: int, prompt: str | None, seed: int) -> str:
        with self._lock:
            v = self.videos.get(vid)
            if v is None:
                raise KeyError("no such video")
            if v.status not in ("succeeded",):
                raise ValueError(f"video is {v.status}")
            scene = next((s for s in v.scenes if s.index == index), None)
            if scene is None:
                raise IndexError("no such scene")
            if scene.state in ("rendering", "retrying") or any(r == "running" for r in v.regens.values()):
                raise RuntimeError("a regeneration is already running")
            rid = uuid.uuid4().hex[:12]
            v.regens[rid] = "running"
            scene.state = "rendering"  # reserve the scene so a second request is refused
        self.pool.submit(self._run_regen, v, scene, rid, prompt, seed)
        return rid

    def _run_regen(self, v: Video, scene: Scene, rid: str, prompt: str | None, seed: int) -> None:
        started = time.time()
        old = (scene.path, scene.prompt, scene.error, scene.revision)
        try:
            if prompt:
                scene.prompt = prompt
            if self._render(v, scene, extra_seed=seed):
                scene.revision += 1
                scene.path = v.dir / f"scene{scene.index}-r{scene.revision}.mp4"
                try:
                    self._compose(v, [s for s in v.scenes if s.state == "done" and s.path])
                    v.regens[rid] = "succeeded"
                    return
                except ComposeError:
                    pass
            # failure: put the previous clip back so the video stays exactly as it was
            scene.path, scene.prompt, scene.error, scene.revision = old
            scene.state, scene.progress = ("done", 1.0) if old[0] else ("failed", 0.0)
            v.regens[rid] = "failed"
        except Exception:  # noqa: BLE001
            scene.path, scene.prompt, scene.error, scene.revision = old
            scene.state, scene.progress = ("done", 1.0) if old[0] else ("failed", 0.0)
            v.regens[rid] = "failed"
        finally:
            v.gpu_seconds = round(v.gpu_seconds + time.time() - started, 2)

    # ---- housekeeping ----------------------------------------------------------------------------------------------
    def get(self, vid: str) -> Video | None:
        return self.videos.get(vid)

    def delete(self, vid: str) -> bool:
        import shutil  # noqa: PLC0415

        with self._lock:
            v = self.videos.get(vid)
            if not v or v.status in ("queued", "running", "composing") or any(r == "running" for r in v.regens.values()):
                return False
            del self.videos[vid]
        shutil.rmtree(v.dir, ignore_errors=True)
        return True

    def _cleanup(self) -> None:
        now = time.time()
        for vid in [v.id for v in self.videos.values() if v.finished and now - v.finished > self.ttl]:
            self.delete(vid)
