import { describe, expect, it } from "vitest";
import { applyEvent, jobProgress, newJob } from "../src/jobs";
import { detectLanguage, evenSplit, planCreative, sceneCount } from "../src/planner";
import { CreativePlanSchema, validatePlanIntegrity } from "../src/plan";
import { RegenError, regenerateScene, runGeneration } from "../src/workflow";
import { setup } from "./helpers";

const IDEA = "Riya exam ke din late uthti hai and races across Pune on her scooter — but when she finally reaches college, she finds out the exam was postponed.";

describe("language detection", () => {
  it.each([
    ["A cat learns to skateboard", "en", false],
    [IDEA, "hi", true],
    ["एक बिल्ली स्केटबोर्ड सीखती है", "hi", false],
    ["तो आज पाऊस आहे आणि मी घरी आहे", "mr", false],
    ["ಒಂದು ಬೆಕ್ಕು ಸ್ಕೇಟ್‌ಬೋರ್ಡ್ ಕಲಿಯುತ್ತದೆ", "kn", false],
    ["એક બિલાડી સ્કેટબોર્ડ શીખે છે", "gu", false],
    ["একটি বিড়াল স্কেটবোর্ড শেখে", "bn", false],
  ])("%s -> %s", (text, code, mixed) => {
    const d = detectLanguage(text);
    expect(d.code).toBe(code);
    expect(d.mixed).toBe(mixed);
  });
});

describe("basic planner", () => {
  const base = { description: IDEA, creativePrompt: "bright handheld vlog", maxClipSeconds: 5 };

  it("follows the prototype scene counts but never exceeds the model's clip length", () => {
    expect([4, 6, 8, 12].map((d) => sceneCount(d, 5))).toEqual([2, 2, 3, 4]);
    expect(sceneCount(30, 5)).toBe(6); // prototype shows 5, but 5 x 6s would exceed a 5s clip limit
    expect(sceneCount(30, 10)).toBe(5);
  });

  it("scene lengths are whole seconds, sum exactly to the request, and fit the clip limit", () => {
    for (const d of [4, 6, 8, 12, 30]) {
      const p = planCreative({ ...base, durationSeconds: d });
      expect(p.scenes.reduce((a, s) => a + s.durationSeconds, 0)).toBe(d);
      expect(Math.max(...p.scenes.map((s) => s.durationSeconds))).toBeLessThanOrEqual(5);
      expect(p.scenes.every((s) => Number.isInteger(s.durationSeconds))).toBe(true);
    }
    expect(evenSplit(8, 3)).toEqual([3, 3, 2]);
  });

  it("produces a valid, internally consistent Creative Plan that preserves the user's text", () => {
    const p = planCreative({ ...base, durationSeconds: 8, category: "Comedy", mood: "Funny", camera: "Let AI decide", motion: "Energetic",
      characters: "Riya — early 20s, curly hair, yellow hoodie. Her mother — 50s, cotton saree." });
    expect(() => CreativePlanSchema.parse(p)).not.toThrow();
    expect(validatePlanIntegrity(p)).toEqual([]);
    expect(p.rawInput.description).toBe(IDEA);
    expect(p.intent.category).toBe("comedy");
    expect(p.inputLanguage).toBe("hi");
    expect(p.scenes[0]!.camera).toBeUndefined(); // "Let AI decide" means no instruction
    expect(p.scenes[0]!.motion).toBe("Energetic");
    expect(p.characters.map((c) => c.name)).toEqual(["Riya", "Her mother"]);
    expect(p.scenes.some((s) => s.characterIds.includes("c1"))).toBe(true);
  });

  it("every scene carries text from the idea, even for a one-sentence idea over many scenes", () => {
    const p = planCreative({ ...base, description: "A cat learns to skateboard", durationSeconds: 30 });
    expect(p.scenes).toHaveLength(6);
    expect(p.scenes.every((s) => s.action.includes("A cat learns to skateboard"))).toBe(true);
    expect(new Set(p.scenes.map((s) => s.action)).size).toBeGreaterThan(1);
  });
});

describe("job tracker", () => {
  it("shows a retry then success, with sensible overall progress", async () => {
    const t = setup({ behavior: { failTimesPerScene: 1 } });
    await t.ledger.grant("u1", 100, "g");
    const r = t.req({ duration: 4 });
    let job = undefined as unknown as ReturnType<typeof newJob>;
    const states: string[] = [];
    t.deps.emit = (e) => {
      job ??= newJob(e.generationId, r.creativePlan.scenes.length);
      applyEvent(job, e);
      states.push(`${job.scenes[0]!.state}:${job.stage}`);
    };
    const g = await runGeneration(t.deps, r);
    expect(job.generationId).toBe(g.id);
    expect(states).toContain("retrying:rendering");
    expect(job.status).toBe("succeeded");
    expect(job.stage).toBe("done");
    expect(job.scenes.every((s) => s.state === "done" && s.attempt === 2)).toBe(true);
    expect(jobProgress(job)).toBe(100);
  });

  it("progress rises monotonically through stages and never hits 100 before the end", () => {
    const job = newJob("g", 2);
    const seen = [jobProgress(job)];
    applyEvent(job, { type: "stage", generationId: "g", stage: "rendering" });
    seen.push(jobProgress(job));
    applyEvent(job, { type: "scene_progress", generationId: "g", index: 0, fraction: 0.5 });
    seen.push(jobProgress(job));
    applyEvent(job, { type: "scene_done", generationId: "g", index: 0, ok: true });
    applyEvent(job, { type: "scene_done", generationId: "g", index: 1, ok: true });
    seen.push(jobProgress(job));
    applyEvent(job, { type: "stage", generationId: "g", stage: "finishing" });
    seen.push(jobProgress(job));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(Math.max(...seen)).toBeLessThan(100);
    applyEvent(job, { type: "status", generationId: "g", status: "succeeded" });
    expect(jobProgress(job)).toBe(100);
  });

  it("ignores events for other generations", () => {
    const job = newJob("a", 1);
    applyEvent(job, { type: "scene_done", generationId: "b", index: 0, ok: true });
    expect(job.scenes[0]!.state).toBe("queued");
  });
});

describe("regenerateScene", () => {
  const sceneCost = 4 * 4; // fake model: 4 credits/s, 4 s scenes (8s video = 2 x 4s)

  async function finished(opts: Parameters<typeof setup>[0] = {}, duration: 4 | 8 | 12 = 8) {
    const t = setup(opts);
    await t.ledger.grant("u1", 200, "g");
    const g = await runGeneration(t.deps, t.req({ duration }));
    return { t, g };
  }

  it("charges only that scene, keeps the others, and recomposes", async () => {
    const { t, g } = await finished();
    expect(g.status).toBe("succeeded");
    const before = await t.ledger.balance("u1");
    const otherBefore = g.scenes[1]!.result;
    const uriBefore = g.outputUri;
    const r = await regenerateScene(t.deps, g.id, 0, "regen-1");
    expect(r.ok).toBe(true);
    expect(r.creditsCharged).toBe(sceneCost);
    const after = await t.ledger.balance("u1");
    expect(after.spent - before.spent).toBe(sceneCost);
    expect(after.held).toBe(0);
    expect(g.scenes[1]!.result).toBe(otherBefore);
    expect(g.scenes[0]!.attempts).toBe(2);
    expect(t.composeCalls.length).toBe(2);
    expect(g.outputUri).toBe(uriBefore); // fake composer is deterministic; the call count proves recompose
  });

  it("a failed scene can be regenerated; success upgrades the generation to succeeded", async () => {
    const { t, g } = await finished({ behavior: { alwaysFailScenes: [1] } });
    expect(g.status).toBe("partial");
    (t.adapter as unknown as { behavior: { alwaysFailScenes: number[] } }).behavior.alwaysFailScenes = [];
    const r = await regenerateScene(t.deps, g.id, 1, "regen-1");
    expect(r.ok).toBe(true);
    expect(g.status).toBe("succeeded");
    expect(g.scenes[1]!.status).toBe("succeeded");
    expect(t.composeCalls.at(-1)).toBe(2);
  });

  it("a failed regeneration costs nothing and leaves the scene untouched", async () => {
    const { t, g } = await finished();
    const before = await t.ledger.balance("u1");
    const sceneBefore = { ...g.scenes[0]! };
    (t.adapter as unknown as { behavior: { alwaysFailScenes: number[] } }).behavior = { alwaysFailScenes: [0] };
    const r = await regenerateScene(t.deps, g.id, 0, "regen-1");
    expect(r.ok).toBe(false);
    expect(r.creditsCharged).toBe(0);
    expect(await t.ledger.balance("u1")).toEqual(before);
    expect(g.scenes[0]!.result).toBe(sceneBefore.result);
    expect(g.scenes[0]!.busy).toBe(false);
    expect(g.status).toBe("succeeded");
  });

  it("a recompose failure refunds the regeneration", async () => {
    const { t, g } = await finished();
    const before = await t.ledger.balance("u1");
    t.deps.composer = { compose: async () => { throw new Error("ffmpeg"); } };
    const r = await regenerateScene(t.deps, g.id, 0, "regen-1");
    expect(r).toMatchObject({ ok: false, errorCode: "COMPOSE_FAILED" });
    expect(await t.ledger.balance("u1")).toEqual(before);
  });

  it("rejects when credits are insufficient, changing nothing", async () => {
    const t = setup();
    await t.ledger.grant("u1", expectedCost(), "g");
    const g = await runGeneration(t.deps, t.req({ duration: 8 }));
    expect((await t.ledger.balance("u1")).available).toBe(0);
    await expect(regenerateScene(t.deps, g.id, 0, "r")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(g.scenes[0]!.attempts).toBe(1);
    function expectedCost() { return 4 * 8 + 0; }
  });

  it("the same idempotency key charges once", async () => {
    const { t, g } = await finished();
    await regenerateScene(t.deps, g.id, 0, "same");
    const mid = await t.ledger.balance("u1");
    const again = await regenerateScene(t.deps, g.id, 0, "same");
    expect(again.creditsCharged).toBe(0);
    expect(await t.ledger.balance("u1")).toEqual(mid);
    expect(g.scenes[0]!.attempts).toBe(2);
  });

  it("refuses a second regeneration of a scene that is already regenerating", async () => {
    const { t, g } = await finished();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const orig = t.adapter.generate.bind(t.adapter);
    t.adapter.generate = async (...a) => { await gate; return orig(...a); };
    const first = regenerateScene(t.deps, g.id, 0, "a");
    await new Promise((r) => setTimeout(r, 5));
    await expect(regenerateScene(t.deps, g.id, 0, "b")).rejects.toMatchObject({ code: "SCENE_BUSY" });
    release();
    expect((await first).ok).toBe(true);
    expect((await t.ledger.balance("u1")).held).toBe(0);
  });

  it("validates its inputs", async () => {
    const { t, g } = await finished();
    await expect(regenerateScene(t.deps, "nope", 0, "k")).rejects.toBeInstanceOf(RegenError);
    await expect(regenerateScene(t.deps, g.id, 9, "k")).rejects.toMatchObject({ code: "BAD_SCENE" });
    const rejected = await runGeneration(t.deps, t.req({ duration: 8, creativePlan: t.req({ duration: 6 }).creativePlan }));
    expect(rejected.status).toBe("rejected");
    await expect(regenerateScene(t.deps, rejected.id, 0, "k")).rejects.toMatchObject({ code: "NOT_FINISHED" });
  });
});
