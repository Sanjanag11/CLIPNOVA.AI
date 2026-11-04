import { describe, expect, it } from "vitest";
import { FakeAdapter, fakeProfile } from "../src/adapters/fake.js";
import { DEFAULT_PLANS, quoteCredits, DEFAULT_PRICING, checkPlanAllows } from "../src/plans.js";
import { runGeneration } from "../src/workflow.js";
import { makePlan, setup } from "./helpers.js";

describe("runGeneration", () => {
  it("happy path: 8s video becomes 2 scenes, is composed, and charges the full quote", async () => {
    const t = setup();
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 8 }));
    expect(g.status).toBe("succeeded");
    expect(g.scenes).toHaveLength(2);
    expect(g.outputUri).toBe(`fake://${g.id}/final.mp4`);
    expect(t.composeCalls).toEqual([2]);
    const quote = quoteCredits(DEFAULT_PRICING, "t2v", "standard", 8);
    expect(g.creditsQuoted).toBe(quote);
    expect(g.creditsCharged).toBe(quote);
    expect(await t.ledger.balance("u1")).toEqual({ available: 100 - quote, held: 0, spent: quote });
  });

  it("emits status and per-scene progress events", async () => {
    const t = setup();
    await t.ledger.grant("u1", 100, "grant");
    await runGeneration(t.deps, t.req({ duration: 4 }));
    const types = t.events.map((e) => e.type);
    expect(types).toContain("scene_started");
    expect(types).toContain("scene_progress");
    expect(types).toContain("scene_done");
    expect(t.events.at(-1)).toMatchObject({ type: "status", status: "succeeded" });
  });

  it("duplicate submit with the same idempotency key runs once and charges once", async () => {
    const t = setup();
    await t.ledger.grant("u1", 100, "grant");
    const r = t.req({ duration: 4, idempotencyKey: "same" });
    const [a, b] = await Promise.all([runGeneration(t.deps, r), runGeneration(t.deps, r)]);
    const c = await runGeneration(t.deps, r);
    expect(a.id).toBe(b.id);
    expect(c.id).toBe(a.id);
    expect(t.adapter.calls).toHaveLength(1);
    const quote = quoteCredits(DEFAULT_PRICING, "t2v", "standard", 4);
    expect((await t.ledger.balance("u1")).spent).toBe(quote);
  });

  it("retries a transient failure and still succeeds without extra charge", async () => {
    const t = setup({ behavior: { failTimesPerScene: 1 } });
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 4 }));
    expect(g.status).toBe("succeeded");
    expect(g.scenes[0]!.attempts).toBe(2);
    expect((await t.ledger.balance("u1")).spent).toBe(g.creditsQuoted);
  });

  it("all scenes fail: status failed, every credit refunded, nothing composed", async () => {
    const t = setup({ behavior: { alwaysFailScenes: [0, 1] } });
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 8 }));
    expect(g.status).toBe("failed");
    expect(g.creditsCharged).toBe(0);
    expect(g.creditsRefunded).toBe(g.creditsQuoted);
    expect(t.composeCalls).toEqual([]);
    expect(await t.ledger.balance("u1")).toEqual({ available: 100, held: 0, spent: 0 });
  });

  it("partial failure: delivers good scenes, charges only those, refunds the failed one", async () => {
    const t = setup({ behavior: { alwaysFailScenes: [1] } });
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 8 }));
    expect(g.status).toBe("partial");
    expect(g.scenes.map((s) => s.status)).toEqual(["succeeded", "failed"]);
    expect(g.creditsCharged + g.creditsRefunded).toBe(g.creditsQuoted);
    expect(g.creditsCharged).toBeGreaterThan(0);
    expect(g.creditsRefunded).toBeGreaterThan(0);
    const b = await t.ledger.balance("u1");
    expect(b.held).toBe(0);
    expect(b.spent).toBe(g.creditsCharged);
    expect(t.composeCalls).toEqual([1]);
  });

  it("falls back to the next model when the first fails non-retryably", async () => {
    const bad = new FakeAdapter(fakeProfile({ id: "cheap-bad", estCostUsdPerSecond: 0.01 }), { alwaysFailScenes: [0], retryable: false });
    const good = new FakeAdapter(fakeProfile({ id: "pricier-good", estCostUsdPerSecond: 0.05 }));
    const t = setup({ extraAdapters: [bad, good] });
    t.registry.setEnabled("fake-standard", false);
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 4 }));
    expect(g.status).toBe("succeeded");
    expect(g.scenes[0]!.modelId).toBe("pricier-good");
  });

  it("composer failure refunds everything", async () => {
    const t = setup();
    t.deps.composer = { compose: async () => { throw new Error("ffmpeg crashed"); } };
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 4 }));
    expect(g.status).toBe("failed");
    expect(g.errorCode).toBe("COMPOSE_FAILED");
    expect(await t.ledger.balance("u1")).toEqual({ available: 100, held: 0, spent: 0 });
  });

  it("insufficient credits is rejected before any model runs", async () => {
    const t = setup();
    await t.ledger.grant("u1", 2, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 8 }));
    expect(g.status).toBe("rejected");
    expect(g.errorCode).toBe("INSUFFICIENT_CREDITS");
    expect(t.adapter.calls).toHaveLength(0);
    expect(await t.ledger.balance("u1")).toEqual({ available: 2, held: 0, spent: 0 });
  });

  it("moderation block rejects without reserving credits", async () => {
    const t = setup({ blocked: ["BADWORD"] });
    await t.ledger.grant("u1", 100, "grant");
    const r = t.req({ duration: 4, creativePlan: makePlan(4, 5, "a story with BADWORD") });
    const g = await runGeneration(t.deps, r);
    expect(g.status).toBe("rejected");
    expect(g.errorCode).toBe("MODERATION_BLOCKED");
    expect(await t.ledger.balance("u1")).toEqual({ available: 100, held: 0, spent: 0 });
  });

  it("free plan cannot request 30s or v2v; premium can request 30s", async () => {
    expect(checkPlanAllows(DEFAULT_PLANS[0]!, "t2v", 30)).not.toEqual([]);
    expect(checkPlanAllows(DEFAULT_PLANS[0]!, "v2v", 4)).not.toEqual([]);
    expect(checkPlanAllows(DEFAULT_PLANS[2]!, "t2v", 30)).toEqual([]);

    const t = setup();
    await t.ledger.grant("u1", 500, "grant");
    const denied = await runGeneration(t.deps, t.req({ plan: DEFAULT_PLANS[0]!, duration: 30, creativePlan: makePlan(30) }));
    expect(denied.status).toBe("rejected");
    const ok = await runGeneration(t.deps, t.req({ plan: DEFAULT_PLANS[2]!, duration: 30, creativePlan: makePlan(30) }));
    expect(ok.status).toBe("succeeded");
    expect(ok.scenes).toHaveLength(6);
  });

  it("enforces per-plan concurrency", async () => {
    const t = setup();
    await t.ledger.grant("u1", 100, "grant");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = t.adapter.generate.bind(t.adapter);
    t.adapter.generate = async (...a) => { await gate; return orig(...a); };
    const free = DEFAULT_PLANS[0]!;
    const first = runGeneration(t.deps, t.req({ plan: free, duration: 4 }));
    await new Promise((r) => setTimeout(r, 10));
    const second = await runGeneration(t.deps, t.req({ plan: free, duration: 4 }));
    expect(second.errorCode).toBe("CONCURRENCY_LIMIT");
    release();
    expect((await first).status).toBe("succeeded");
  });

  it("rejects scene durations that do not match the requested duration", async () => {
    const t = setup();
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 8, creativePlan: makePlan(6) }));
    expect(g.status).toBe("rejected");
    expect(g.errorCode).toBe("INVALID_REQUEST");
  });

  it("rejects when no model supports the mode (e.g. v2v)", async () => {
    const t = setup();
    t.registry.setEnabled("fake-standard", false);
    t.registry.register(new FakeAdapter(fakeProfile({ id: "t2v-only", modes: ["t2v"] })));
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ mode: "v2v", duration: 4 }));
    expect(g.errorCode).toBe("NO_MODEL");
  });

  it("never routes to a model without a commercial licence", async () => {
    const t = setup();
    t.registry.setEnabled("fake-standard", false);
    t.registry.register(new FakeAdapter(fakeProfile({ id: "research-only", licence: { id: "nc", commercialUse: false } })));
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 4 }));
    expect(g.errorCode).toBe("NO_MODEL");
  });

  it("respects gradual rollout buckets", async () => {
    const t = setup();
    t.registry.setEnabled("fake-standard", false);
    t.registry.register(new FakeAdapter(fakeProfile({ id: "canary" })), { rolloutPct: 10 });
    await t.ledger.grant("u1", 100, "grant");
    const inside = await runGeneration(t.deps, t.req({ duration: 4, rolloutBucket: 5 }));
    const outside = await runGeneration(t.deps, t.req({ duration: 4, rolloutBucket: 50 }));
    expect(inside.status).toBe("succeeded");
    expect(outside.errorCode).toBe("NO_MODEL");
  });

  it("an unexpected internal error never leaves credits held", async () => {
    const t = setup();
    t.deps.ledger.capture = async () => { throw new Error("db down"); };
    await t.ledger.grant("u1", 100, "grant");
    await expect(runGeneration(t.deps, t.req({ duration: 4 }))).rejects.toThrow("db down");
    expect((await t.ledger.balance("u1")).held).toBe(0);
  });
});
