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
- `apps/web`       Next.js 16 app.
  - `app/_screens/*.tsx` are GENERATED from the prototype (never hand-edit).
  - `app/_live/MainLive.tsx` extends the generated Create screen and replaces its simulated data with the real API.
  - `app/api/*` route handlers: me, models, quote, plan, generations (+ `[id]`, scene regenerate, rating).
  - `lib/service.ts` DEMO service: in-memory ledger/store and FakeAdapter models with a simulated render delay.
  - `test/api.test.ts` integration tests that call the route handlers directly.
- `design/prototype` Source of truth for the UI: the six `.dc.html` screens exported from the design canvas.
- `tools/dc2react.mjs` Converts `design/prototype/*.dc.html` into React screens. To change the UI: edit the prototype
  file (or re-export it from the canvas), run `node tools/dc2react.mjs`, never hand-edit `_screens/`.
- (planned) `apps/api`, `workers/inference` (Python), `workers/media`.

## Rules that must not be broken
1. No model-specific logic outside a `VideoModelAdapter`. The workflow only sees `CapabilityProfile` + the adapter interface.
2. Never route to a model whose licence is not commercially usable (`licence.commercialUse`). Re-check licences on every model upgrade.
3. Money moves only through the append-only ledger, with an idempotency key on every write.
4. Register a generation in the store before the first `await` (duplicate-submit protection).
5. No API keys or credentials in frontend code or in the repo. Use `.env` (git-ignored) / secret manager.
6. Never claim a feature works without a test or a real run. Vendor figures are labelled "vendor-stated" until benchmarked.

## Conventions
- TypeScript strict, ESM, zod for runtime schemas. Python (inference workers) with type hints.
- Tests: vitest. Every business rule above has a test. Run `npm test` and `npm run typecheck` before committing.
- Branches: `feat/...`; small commits; decisions recorded in `docs/adr/`.

## Commands
- `npm install`
- `npm test`          run all package tests (core + web: vitest)
- `npm run dev -w @clipnova/web`   run the web app on :3000
- Demo mode: `next start` runs in production mode, where the demo identity is OFF (API returns 501 AUTH_NOT_CONFIGURED).
  Set `CLIPNOVA_DEMO=1` to enable it; `CLIPNOVA_DEMO_RENDER_MS` sets the simulated render time per scene (default 1600).
  Try plans and licence territories with `/create?plan=free|creator|pro&region=DE`. NEVER set CLIPNOVA_DEMO in a real deployment.
- `node tools/dc2react.mjs`        regenerate screens from design/prototype
- `npm run typecheck` typecheck all packages

## Status
Milestone 1.1 in progress.
Done and tested: core domain + workflow (71 vitest tests); web API layer (17 tests); all six prototype screens in Next.js.
The Create screen is wired to the real backend: live cost quote and balance from the ledger, planning via the API,
asynchronous generation with real progress, scene edits sent to the job, per-scene regeneration (charges only that scene),
full regenerate, ratings, region-aware model availability. Browser-verified end to end (Playwright, manual scripts; not yet in the repo).
Honest limits (all shown by the in-app "Demo mode" banner or labelled in the UI):
- Models are fake adapters: no real video is produced. The player is a placeholder; "Download MP4" does nothing.
- The planner is basic and deterministic (splits the idea into scenes). The Claude planner is not built.
- Uploads (image/video modes) are simulated and not stored. No audio is generated (voiceover/music/sfx are priced but not produced).
- Moderation is not enabled. "Saved to Library" is prototype copy: Library, Model Lab and Admin still show the prototype's sample data.
- State is in memory (lost on restart); no sign-in (demo user per plan), no database, no payments, no durable job queue.
Next: sign-in + Postgres ledger/jobs, real Wan 2.2 adapter on a GPU provider, Claude planner, ffmpeg composer, moderation.
