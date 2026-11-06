# ClipNova.ai

AI video creation SaaS for Gen Z creators, influencers and small businesses. Launch markets: India and global (undecided priority).
Turn text, images and videos into publishable short-form video (Reels, Shorts, TikTok).
Three experiences: Text to Video (t2v), Image to Video (i2v), Video to Video (v2v).

Full Phase 0 assessment (architecture, model matrix, licences, backlog, risks):
https://claude.ai/artifact/GZRLgQ45GDHa5EfuAExLnQ

## Product constraints
- Durations: 4, 6, 8, 12 s; 30 s needs a paid plan (Creator/Pro). Aspect ratios 9:16, 16:9, 1:1, 4:5.
- Plans (from the approved prototype): Free 120 credits (<=12 s, 720p, watermark), Creator 900, Pro 2500. Prices are still [PRICE] placeholders.
- Credits per video = model rate x seconds (Wan 6, LTX 3, Hunyuan 7, Cog 4, VACE 6, SVD 3, LongCat 7, Mochi 5, Open-Sora 4 in the prototype; unverified placeholders until Phase 2) + voiceover 1 per 4 s + music 2 + sound effects 1; captions free.
- "Auto" model picks by mode (prototype: text/image -> Wan 2.2, video -> VACE). A model the user picks is never silently swapped.
- Licence obligations (verified 6 Nov 2026, docs/open-source-stack.md): LTX-Video (v0.9.6+) is free below $10M annual revenue and requires
  user terms carrying its use restrictions plus a disclosure that content is machine-generated (NOT BUILT; paid plans have no visible watermark).
  HunyuanVideo 1.5 also requires labelling AI output. Wan 2.2 and CogVideoX-2B are Apache-2.0.
- Global market: model licences can exclude territories. HunyuanVideo 1.5 excludes the EU, UK and South Korea, so it is never routed for users there (`licence.excludedTerritories`, enforced in `ModelRegistry.select`).
- Launch languages: en, hi, mr, kn, gu, bn. Languages are data; adding one must not need workflow changes.
- Users describe ideas in their own language; video prompts are always rendered in English; narration/captions stay in the user's language.
- Credits are reserved at submit, captured per successful scene, released for failures. Users never pay for failed output.
- Plans, pricing and credit costs are data (`plans.ts` now, DB rows + admin UI later), never hard-coded in the workflow.

## Design source
The approved UI prototype is the design canvas https://claude.ai/artifact/FimG8xtmbsNWZSRTzq48as
(screens: Landing, Create, Library, Plans & credits, Model Lab, Admin). Dark theme: bg #101014, surface #19191F,
card #222129, hover #2B2933, primary #A78BFA / hover #C4B5FD, text #F5F4F7, secondary text #A5A2AF, border #34323D,
success #34D399, warning #FBBF24, error #F87171. Font Inter. Radii 8 controls / 12-16 cards / 16-20 panels.
Prototype admin figures are illustrative sample data only; do not present them as real metrics.

## Architecture (see assessment section 4)
Four layers: product (Next.js web + API) -> durable generation workflow -> execution (GPU model workers,
audio providers, ffmpeg media worker, LLM) -> data (Postgres, R2, analytics).
Application hosting never runs models. Generation is always asynchronous.

Repo layout:
- `packages/core`  Business logic, no I/O: Creative Plan schema, credit ledger, plans/pricing,
  model contract + registry, generation workflow. In-memory implementations for tests.
- `apps/web`       Next.js 16 app (deploys to Vercel; root directory `apps/web`).
  - `app/_screens/*.tsx` are GENERATED from the prototype (never hand-edit).
  - `app/_live/MainLive.tsx` extends the generated Create screen and replaces its simulated data with the real API.
  - `app/api/*` thin route handlers; they call an `Engine` (`lib/engines/types.ts`) chosen by `lib/service.ts`:
    - `SimEngine` (default): in memory, fake models, no video.
    - `LiveEngine` (set `CLIPNOVA_WORKER_URL`): STATELESS, Postgres + a remote GPU worker; works on serverless. See ADR 0003.
  - `lib/db/` Postgres (`DATABASE_URL`, e.g. Neon) or embedded PGlite for local dev/tests; `SqlLedger` passes the same contract tests as the in-memory ledger.
  - `lib/live/` the live engine, generation repository, worker client. `lib/files.ts` Vercel Blob (prod) / disk (dev).
  - `proxy.ts` + `lib/access.ts` fail-closed access gate (`CLIPNOVA_ACCESS_CODE`).
  - `lib/catalog.ts` business metadata per live model (price, licence, shapes).
- `workers/inference` Python worker that serves open-source video models (Wan 2.2 5B, LTX-Video, CogVideoX-2B) over HTTP.
  It runs whole videos (`/v1/videos`: render scenes, retry, stitch with ffmpeg, regenerate one scene). ffmpeg exists ONLY here.
  Logic and protocol are tested (75 pytest, real ffmpeg); the three diffusers pipelines are NOT yet run on a GPU.
  `WORKER_FAKE=1` renders ffmpeg test patterns so the whole stack runs without a GPU. Deployment: `modal_app.py` (untested), `docs/free-gpu.md`.
- `docs/open-source-stack.md` open-source choice per purpose, with licence status (verified vs unverified).
- `design/prototype` Source of truth for the UI: the six `.dc.html` screens exported from the design canvas.
- `tools/dc2react.mjs` Converts `design/prototype/*.dc.html` into React screens. To change the UI: edit the prototype
  file (or re-export it from the canvas), run `node tools/dc2react.mjs`, never hand-edit `_screens/`.
- (planned) `apps/api`, `workers/inference` (Python), `workers/media`.

## Rules that must not be broken
1. No model-specific logic outside a `VideoModelAdapter`. The workflow only sees `CapabilityProfile` + the adapter interface.
2. Never route to a model whose licence is not commercially usable (`licence.commercialUse`). Re-check licences on every model upgrade.
3. Money moves only through the append-only ledger, with an idempotency key on every write.
4. Register a generation (insert its row / store it) before any slow step (duplicate-submit protection).
5. Serverless rule: the web app keeps NO state in memory that matters, runs no ffmpeg, and never waits on a GPU inside a request.
6. No API keys or credentials in frontend code or in the repo. Use `.env` (git-ignored) / secret manager.
7. Never claim a feature works without a test or a real run. Vendor figures are labelled "vendor-stated" until benchmarked.

## Conventions
- TypeScript strict, ESM, zod for runtime schemas. Python (inference workers) with type hints.
- Tests: vitest. Every business rule above has a test. Run `npm test` and `npm run typecheck` before committing.
- Branches: `feat/...`; small commits; decisions recorded in `docs/adr/`.

## Commands
- `npm install`
- `npm test`          run all package tests (core + web: vitest)
- `npm run dev -w @clipnova/web`   run the web app on :3000
- Live engine (see `apps/web/.env.example` and `docs/deploy-vercel.md`): `CLIPNOVA_WORKER_URL`, `CLIPNOVA_WORKER_TOKEN`,
  `CLIPNOVA_WORKER_MODELS` (e.g. `ltx`), `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `CLIPNOVA_ACCESS_CODE`, `CLIPNOVA_DEMO=1`.
  Locally without `DATABASE_URL` the embedded database is used under `CLIPNOVA_DATA_DIR`. Worker: `workers/inference/README.md`.
- Demo mode: `next start` runs in production mode, where the demo identity is OFF (API returns 501 AUTH_NOT_CONFIGURED).
  Set `CLIPNOVA_DEMO=1` to enable it; `CLIPNOVA_DEMO_RENDER_MS` sets the simulated render time per scene (default 1600).
  Try plans and licence territories with `/create?plan=free|creator|pro&region=DE`. NEVER set CLIPNOVA_DEMO in a real deployment.
- `node tools/dc2react.mjs`        regenerate screens from design/prototype
- `npm run typecheck` typecheck all packages

## Status
Milestone 1.1 in progress.
Done and tested: core (91 vitest), web (SQL ledger, live engine, API, access gate, database), Python worker (75 pytest).
Verified end to end locally in a production build: access gate -> plan -> generate (real Python worker rendering ffmpeg test patterns)
-> stitched 8 s 720x1280 video playing in a real browser -> regenerate one scene (charged only that scene) -> rating; and the worker
being killed mid-video refunds every credit. See `docs/deploy-vercel.md` for putting it on Vercel + Modal.
NOT verified (needs your accounts/hardware): the Vercel deployment, Neon, Vercel Blob, Modal, and the real LTX-Video model on a GPU.
Honest limits:
- Only Text to Video with ONE model (LTX-Video) is live; image/video modes need stored uploads (not built).
- No audio is produced, so the live engine does not charge for it (tested). Prototype copy such as "Hindi voiceover" and
  "saved to Library" is still shown on the result screen.
- Planner is basic and deterministic; prompts are not translated to English yet. Moderation is OFF.
- Library, Model Lab and Admin show the prototype's sample data. No sign-in (shared demo user per plan behind an access code), no payments.
- The worker keeps jobs in memory in one container; a restart loses in-flight videos (they are refunded).
Next: deploy and benchmark LTX on a real GPU; sign-in; Claude/open-LLM planner; audio; moderation.
