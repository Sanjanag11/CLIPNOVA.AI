"""One GPU, one job at a time. Jobs queue in memory; finished files are removed after a while."""
from __future__ import annotations

import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .pipelines.base import GenerateRequest, ModelFailure, VideoPipeline


class QueueFull(Exception):
    pass


@dataclass
class Job:
    id: str
    model: str
    request: GenerateRequest
    status: str = "queued"          # queued | running | succeeded | failed
    progress: float = 0.0
    error: dict | None = None       # {"code", "message", "retryable"}
    gpu_seconds: float = 0.0
    created: float = field(default_factory=time.time)
    finished: float | None = None


class JobManager:
    def __init__(self, registry: dict[str, VideoPipeline], data_dir: Path, max_queue: int = 8, ttl_seconds: int = 3600) -> None:
        self.registry = registry
        self.dir = data_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.max_queue = max_queue
        self.ttl = ttl_seconds
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")  # the GPU lock

    def submit(self, model: str, prompt: str, negative: str, seconds: float, aspect: str, seed: int, steps: int | None) -> Job:
        self._cleanup()
        with self._lock:
            active = sum(1 for j in self.jobs.values() if j.status in ("queued", "running"))
            if active >= self.max_queue:
                raise QueueFull()
            jid = uuid.uuid4().hex
            req = GenerateRequest(prompt, negative, seconds, aspect, seed, steps, self.dir / f"{jid}.mp4")
            job = Job(jid, model, req)
            self.jobs[jid] = job
        self._pool.submit(self._run, job)
        return job

    def _run(self, job: Job) -> None:
        job.status = "running"
        started = time.time()
        pipe = self.registry[job.model]
        try:
            pipe.generate(job.request, lambda p: setattr(job, "progress", max(job.progress, min(0.99, p))))
            if not job.request.out_path.exists() or job.request.out_path.stat().st_size < 1024:
                raise ModelFailure("EMPTY_OUTPUT", "the model produced no video", retryable=True)
            job.progress = 1.0
            job.status = "succeeded"
        except ModelFailure as e:
            job.status, job.error = "failed", {"code": e.code, "message": str(e), "retryable": e.retryable}
        except Exception as e:  # noqa: BLE001 - a crashed job must never take the worker down
            job.status, job.error = "failed", {"code": "MODEL_ERROR", "message": f"{type(e).__name__}: {str(e)[:200]}", "retryable": True}
        finally:
            job.gpu_seconds = round(time.time() - started, 2)
            job.finished = time.time()
            try:
                pipe.cleanup()
            except Exception:  # noqa: BLE001
                pass

    @property
    def pool(self) -> ThreadPoolExecutor:
        return self._pool

    def get(self, jid: str) -> Job | None:
        return self.jobs.get(jid)

    def delete(self, jid: str) -> bool:
        with self._lock:
            job = self.jobs.get(jid)
            if not job or job.status in ("queued", "running"):
                return False
            del self.jobs[jid]
        job.request.out_path.unlink(missing_ok=True)
        return True

    def _cleanup(self) -> None:
        now = time.time()
        for jid in [j.id for j in self.jobs.values() if j.finished and now - j.finished > self.ttl]:
            self.delete(jid)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
        shutil.rmtree(self.dir, ignore_errors=True)
