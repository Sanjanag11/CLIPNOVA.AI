# ADR 0003: A stateless live engine for serverless hosting

Status: accepted (M1.1)

## Context
Vercel functions are short-lived and share nothing between requests: no background work after a response, no disk
that persists, no ffmpeg, and no GPU. The first live engine kept jobs in memory and ran ffmpeg locally, which cannot work there.

## Decision
- State lives in Postgres: an append-only credit ledger (per-user advisory lock around balance checks), a `generations`
  table holding each job as JSON, and ratings. Embedded Postgres (PGlite) is used for local development and tests.
- The Python worker runs a whole video as one job (render scenes with retries, stitch with ffmpeg, regenerate one scene) and
  is polled. The web app starts a job, then each status request asks the worker, and when a video is ready stores it
  (Vercel Blob in production, disk locally) and settles credits.
- A 30-second lease inside the job row means simultaneous status checks cannot settle credits twice; every ledger write
  also carries an idempotency key.
- Anything that can go wrong ends in a refund: worker unreachable, restarted, too slow, rejected, failed, or a function that died
  between reserving credits and handing over the job.
- A fail-closed access gate (`proxy.ts`) protects deployments that attach a GPU.

## Consequences
- The simulated engine (in memory, fake models) remains for demos and the prototype flow; both engines pass the same API contract.
- Polling is used instead of push. Server-sent events or a queue can replace it later.
- The per-scene `HttpVideoAdapter` and model fallback in `packages/core` are not used by this engine (one model is live);
  they remain for the multi-model case.
- The worker holds job state in memory and runs as one container; a restart loses in-flight videos (they are refunded).
