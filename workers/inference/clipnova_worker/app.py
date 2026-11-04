"""HTTP API. The TypeScript adapter (packages/core/src/adapters/http.ts) is the client; keep the two in step.

  GET    /healthz                  open, minimal
  GET    /v1/models                what this worker serves, with verified capabilities
  POST   /v1/jobs                  {model, prompt, negativePrompt?, seconds, aspectRatio, seed?, steps?} -> 202 {jobId}
  GET    /v1/jobs/{id}             {status, progress, gpuSeconds, error?{code,message,retryable}}
  GET    /v1/jobs/{id}/video       the mp4 (409 until the job has succeeded)
  DELETE /v1/jobs/{id}
"""
from __future__ import annotations

import hmac
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .config import Settings
from .jobs import JobManager, QueueFull
from .pipelines.base import VideoPipeline

log = logging.getLogger("clipnova.worker")


class JobIn(BaseModel):
    model: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=2000)
    negativePrompt: str = Field(default="", max_length=1000)
    seconds: float = Field(gt=0, le=60)
    aspectRatio: str
    seed: int = Field(default=0, ge=0, lt=2**32)
    steps: int | None = Field(default=None, ge=4, le=100)


def create_app(registry: dict[str, VideoPipeline], settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if not settings.token and not settings.allow_anon:
        raise RuntimeError("Set WORKER_TOKEN (or WORKER_ALLOW_ANON=1 for local development only). Refusing to serve an open GPU.")
    app = FastAPI(title="ClipNova inference worker", docs_url=None, redoc_url=None)
    jobs = JobManager(registry, settings.data_dir, settings.max_queue, settings.ttl_seconds)
    app.state.jobs = jobs

    def auth(authorization: str | None = Header(default=None)) -> None:
        if settings.allow_anon and not settings.token:
            return
        scheme, _, supplied = (authorization or "").partition(" ")
        ok = scheme.lower() == "bearer" and hmac.compare_digest(supplied.strip().encode(), (settings.token or "").encode())
        if not ok:
            raise HTTPException(401, "unauthorized")

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.get("/v1/models", dependencies=[Depends(auth)])
    def models() -> dict:
        out = []
        for p in registry.values():
            c = p.capability
            out.append({
                "id": c.id, "name": c.name, "modes": list(c.modes), "aspectRatios": list(c.aspect_ratios),
                "maxSeconds": c.max_seconds, "fps": c.fps, "sizes": {k: list(v) for k, v in c.sizes.items()},
                "minVramGb": c.min_vram_gb, "licence": c.licence, "notes": c.notes,
            })
        return {"models": out}

    @app.post("/v1/jobs", status_code=202, dependencies=[Depends(auth)])
    def create_job(body: JobIn) -> dict:
        pipe = registry.get(body.model)
        if pipe is None:
            raise HTTPException(404, f"this worker does not serve '{body.model}'")
        c = pipe.capability
        if body.aspectRatio not in c.aspect_ratios:
            raise HTTPException(422, f"{c.name} does not support {body.aspectRatio}")
        if body.seconds > c.max_seconds:
            raise HTTPException(422, f"{c.name} renders at most {c.max_seconds}s per clip")
        try:
            job = jobs.submit(body.model, body.prompt, body.negativePrompt, body.seconds, body.aspectRatio, body.seed, body.steps)
        except QueueFull:
            raise HTTPException(429, "the queue is full; try again shortly") from None
        return {"jobId": job.id}

    @app.get("/v1/jobs/{job_id}", dependencies=[Depends(auth)])
    def job_status(job_id: str) -> dict:
        j = jobs.get(job_id)
        if j is None:
            raise HTTPException(404, "no such job")
        out: dict = {"status": j.status, "progress": round(j.progress, 3), "gpuSeconds": j.gpu_seconds}
        if j.error:
            out["error"] = j.error
        return out

    @app.get("/v1/jobs/{job_id}/video", dependencies=[Depends(auth)])
    def job_video(job_id: str):
        j = jobs.get(job_id)
        if j is None:
            raise HTTPException(404, "no such job")
        if j.status != "succeeded":
            raise HTTPException(409, f"job is {j.status}")
        return FileResponse(j.request.out_path, media_type="video/mp4")

    @app.delete("/v1/jobs/{job_id}", status_code=204, dependencies=[Depends(auth)])
    def delete_job(job_id: str) -> None:
        if not jobs.delete(job_id):
            raise HTTPException(404, "no such finished job")

    return app
