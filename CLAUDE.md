# ClipNova.ai

AI video creation SaaS for Gen Z creators, influencers and small businesses (India first).
Turn text, images and videos into publishable short-form video (Reels, Shorts, TikTok).
Three experiences: Text to Video (t2v), Image to Video (i2v), Video to Video (v2v).

Full Phase 0 assessment (architecture, model matrix, licences, backlog, risks):
https://claude.ai/artifact/GZRLgQ45GDHa5EfuAExLnQ

## Product constraints
- Durations: 4, 6, 8, 12 s; 30 s is premium only. Aspect ratios 9:16, 1:1, 16:9.
- Launch languages: en, hi, mr, kn, gu, bn. Languages are data; adding one must not need workflow changes.
- Users describe ideas in their own language; video prompts are always rendered in English; narration/captions stay in the user's language.
- Credits are reserved at submit, captured per successful scene, released for failures. Users never pay for failed output.
- Plans, pricing and credit costs are data (`plans.ts` now, DB rows + admin UI later), never hard-coded in the workflow.

## Architecture (see assessment section 4)
Four layers: product (Next.js web + API) -> durable generation workflow -> execution (GPU model workers,
audio providers, ffmpeg media worker, LLM) -> data (Postgres, R2, analytics).
Application hosting never runs models. Generation is always asynchronous.

Repo layout:
- `packages/core`  Business logic, no I/O: Creative Plan schema, credit ledger, plans/pricing,
  model contract + registry, generation workflow. In-memory implementations for tests.
- (planned) `apps/web`, `apps/api`, `workers/inference` (Python), `workers/media`.

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
- `npm test`          run all package tests
- `npm run typecheck` typecheck all packages

## Status
Milestone 1.1 in progress: core domain + workflow done and tested with a fake adapter.
Not built yet: web app, API, auth, DB, storage, real GPU adapter (Wan 2.2 TI2V-5B), LLM planner, ffmpeg composer.
