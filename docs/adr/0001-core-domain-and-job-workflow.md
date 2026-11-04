# ADR 0001: Pure core domain with an adapter-based generation workflow

Status: accepted (M1.1)

## Context
ClipNova must run many video models with different capabilities, change prices/plans without redeploys,
and never charge for failed output. GPU inference is slow (minutes), unreliable and expensive.

## Decision
- Put business logic in `packages/core` with no I/O. Ports (ledger, store, moderator, composer, model registry) are
  interfaces; in-memory implementations back the tests. Production adapters (Postgres, R2, Temporal, GPU workers) come later.
- All models sit behind `VideoModelAdapter` + `CapabilityProfile`. Selection is rule-based (enabled, licensed, mode, aspect ratio,
  tier, rollout bucket; cheapest first) and failed scenes retry, then reroute to the next candidate.
- Credits use an append-only ledger: reserve -> capture per successful scene / release for failures; idempotency key per write.
- A generation is registered in the store before the first await so concurrent duplicate submits resolve to one job.

## Consequences
- Fully testable without GPUs; failure handling is proven before real models exist.
- The in-memory workflow is a reference implementation. In production the same steps run as a durable workflow (Temporal);
  the step logic stays, the persistence moves.
- Per-scene credit allocation uses largest-remainder so reserved credits always reconcile exactly.

## Known gaps
- No output-frame moderation or automatic quality checks yet.
- Scenes render sequentially; no last-frame chaining.
- Placeholder pricing values until Phase 2 measures real cost per successful second.
