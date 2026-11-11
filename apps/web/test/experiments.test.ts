import { describe, expect, it } from "vitest";
import { EXPERIMENTS, assign, liveExperiments, type Experiment } from "../lib/experiments";

const uids = (n: number) => Array.from({ length: n }, (_, i) => (i * 2654435761 + 12345).toString(16).padStart(8, "0").repeat(4).slice(0, 32));

describe("A/B assignment", () => {
  it("is deterministic: the same tester always gets the same variants", () => {
    const u = uids(50);
    for (const id of u) expect(assign(id)).toEqual(assign(id));
  });

  it("gives every tester a valid variant of every live experiment", () => {
    for (const id of uids(200)) {
      const a = assign(id);
      for (const e of EXPERIMENTS) expect(e.variants.map((v) => v.id)).toContain(a[e.id]);
    }
  });

  it("splits testers by the configured weights", () => {
    const n = 10_000;
    for (const e of EXPERIMENTS) {
      const counts: Record<string, number> = {};
      for (const id of uids(n)) { const v = assign(id)[e.id]!; counts[v] = (counts[v] ?? 0) + 1; }
      for (const v of e.variants) expect(Math.abs((counts[v.id] ?? 0) / n - v.weight / 100)).toBeLessThan(0.03);
    }
    const lopsided: Experiment[] = [{ id: "x", description: "", variants: [{ id: "a", weight: 90 }, { id: "b", weight: 10 }] }];
    const a = uids(10_000).filter((id) => assign(id, lopsided).x === "a").length;
    expect(a / 10_000).toBeGreaterThan(0.87);
    expect(a / 10_000).toBeLessThan(0.93);
  });

  it("experiments are independent of each other (no accidental correlation)", () => {
    const n = 10_000;
    let both = 0;
    for (const id of uids(n)) { const a = assign(id); if (a.prompt_boost === "boost" && a.default_length === "4s") both++; }
    expect(Math.abs(both / n - 0.25)).toBeLessThan(0.03);
  });

  it("can be limited to some experiments with CLIPNOVA_EXPERIMENTS", () => {
    expect(liveExperiments({ CLIPNOVA_EXPERIMENTS: "prompt_boost" }).map((e) => e.id)).toEqual(["prompt_boost"]);
    expect(liveExperiments({ CLIPNOVA_EXPERIMENTS: " savings_hint , nope " }).map((e) => e.id)).toEqual(["savings_hint"]);
    expect(liveExperiments({}).length).toBe(EXPERIMENTS.length);
    expect(Object.keys(assign("a".repeat(32), liveExperiments({ CLIPNOVA_EXPERIMENTS: "prompt_boost" })))).toEqual(["prompt_boost"]);
  });

  it("ignores an experiment with no weight", () => {
    expect(assign("b".repeat(32), [{ id: "dead", description: "", variants: [{ id: "a", weight: 0 }] }])).toEqual({});
  });

  it("every experiment has a description and at least two variants", () => {
    for (const e of EXPERIMENTS) { expect(e.description.length).toBeGreaterThan(20); expect(e.variants.length).toBeGreaterThanOrEqual(2); }
  });
});
