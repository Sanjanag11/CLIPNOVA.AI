# ADR 0002: Wire generated prototype screens through a live subclass

Status: accepted (M1.1)

## Context
The approved prototype is exported as `.dc.html` screens whose logic simulates everything. We want the UI to stay
identical to the design while the data comes from the real backend, without forking generated code.

## Decision
- `tools/dc2react.mjs` generates one React component per screen and exports its logic `Component` and `STYLES`.
- `app/_live/MainLive.tsx` subclasses the generated `Component`, calls `super.renderVals()` and overrides only the keys
  that must come from the server (cost, balance, plan, progress, scenes, regenerate, ratings). Everything else stays the prototype's.
- Generation is asynchronous: `POST /api/generations` returns 202 and the screen polls `GET /api/generations/:id`.
  Progress is built from workflow events (`stage`, `scene_started`, `scene_attempt_failed`, `scene_progress`, `scene_done`).
- Demo identity (`?plan=`, `?region=`) exists only while `CLIPNOVA_DEMO=1` or outside production; otherwise the API returns 501.

## Consequences
- Re-exporting the prototype updates the UI with no merge work; the live layer keeps working while the keys it overrides exist.
- Polling is simple but not push; server-sent events replace it once jobs are durable.
- The in-process background run is only valid for one long-lived server; production needs a queue/workflow engine (Temporal).
