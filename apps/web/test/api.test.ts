import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The demo service reads these once, when it is first created.
process.env.CLIPNOVA_DEMO = "1";
process.env.CLIPNOVA_DEMO_RENDER_MS = "0";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx?: any) => Promise<Response>;
let me: { GET: Handler }, models: { GET: Handler }, quote: { POST: Handler }, plan: { POST: Handler };
let gens: { POST: Handler }, gen: { GET: Handler }, regen: { POST: Handler }, rating: { POST: Handler };

beforeAll(async () => {
  me = await import("../app/api/me/route");
  models = await import("../app/api/models/route");
  quote = await import("../app/api/quote/route");
  plan = await import("../app/api/plan/route");
  gens = await import("../app/api/generations/route");
  gen = await import("../app/api/generations/[id]/route");
  regen = await import("../app/api/generations/[id]/scenes/[index]/regenerate/route");
  rating = await import("../app/api/generations/[id]/rating/route");
});

const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://x${url}`);
const base = { mode: "t2v", durationSeconds: 8, aspectRatio: "9:16", addons: { voice: true, music: true, sfx: true } };
const idea = { description: "A cat learns to skateboard. It falls, then it tries again, and finally it rolls down the street.", creativePrompt: "bright and funny", language: "en" };
let n = 0;
const key = () => `test-key-${++n}-padding`;

async function waitDone(id: string, plan: string) {
  for (let i = 0; i < 100; i++) {
    const r = await (await gen.GET(get(`/api/generations/${id}?plan=${plan}`), { params: Promise.resolve({ id }) })).json();
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("generation did not finish");
}
async function run(planId: string, over: Record<string, unknown> = {}) {
  const p = await (await plan.POST(post("/api/plan", { plan: planId, ...base, ...idea, ...over }))).json();
  const k = key();
  const start = await gens.POST(post("/api/generations", { plan: planId, ...base, ...over, idempotencyKey: k, creativePlan: p.plan }));
  return { p, k, start, body: await start.json() };
}
const balance = async (planId: string) => (await (await me.GET(get(`/api/me?plan=${planId}`))).json()).balance;

describe("demo identity gate", () => {
  it("is switched off in production unless explicitly enabled", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { demo: env.CLIPNOVA_DEMO, node: env.NODE_ENV };
    env.CLIPNOVA_DEMO = undefined; env.NODE_ENV = "production";
    try {
      const r = await me.GET(get("/api/me?plan=pro"));
      expect(r.status).toBe(501);
      expect((await r.json()).code).toBe("AUTH_NOT_CONFIGURED");
    } finally { env.CLIPNOVA_DEMO = saved.demo; env.NODE_ENV = saved.node; }
  });
  it("rejects unknown plans and malformed regions", async () => {
    expect((await me.GET(get("/api/me?plan=platinum"))).status).toBe(400);
    expect((await me.GET(get("/api/me?plan=free&region=XYZ"))).status).toBe(400);
  });
});

describe("plans, models and quotes", () => {
  it("grants each demo plan its monthly credits once", async () => {
    expect((await balance("free")).available + (await balance("free")).spent).toBe(120);
    expect((await balance("creator")).available).toBe(900);
    expect((await balance("pro")).available).toBe(2500);
  });
  it("quotes the prototype price: 8s on Wan 2.2 with voice, music and sfx = 53", async () => {
    const q = await (await quote.POST(post("/api/quote", { plan: "pro", ...base }))).json();
    expect(q.quote.total).toBe(53);
    expect(q.audioAvailable).toBe(true); // the simulated engine prices audio, as in the prototype
    expect(q.modelUsed).toBe("Wan 2.2");
    expect(q.canAfford).toBe(true);
  });
  it("uses VACE for video-to-video and honours a chosen model", async () => {
    expect((await (await quote.POST(post("/api/quote", { plan: "pro", ...base, mode: "v2v" }))).json()).modelUsed).toBe("VACE");
    expect((await (await quote.POST(post("/api/quote", { plan: "pro", ...base, modelId: "ltx" }))).json()).quote.lines[0].credits).toBe(24);
  });
  it("hides HunyuanVideo from EU/UK/KR users and shows it in India", async () => {
    const list = async (region: string) => (await (await models.GET(get(`/api/models?plan=pro&mode=t2v&aspect=9:16&region=${region}`))).json()).models;
    for (const r of ["DE", "GB", "KR"]) expect((await list(r)).find((m: any) => m.id === "hunyuan")).toMatchObject({ available: false, reason: "Not available in your region" });
    expect((await list("IN")).find((m: any) => m.id === "hunyuan").available).toBe(true);
    const q = await (await quote.POST(post("/api/quote", { plan: "pro", ...base, modelId: "hunyuan", region: "DE" }))).json();
    expect(q.code).toBe("NO_MODEL");
  });
  it("rejects invalid bodies", async () => {
    expect((await quote.POST(post("/api/quote", { plan: "pro", ...base, durationSeconds: -1 }))).status).toBe(400);
    expect((await plan.POST(post("/api/plan", { plan: "pro", ...base, description: "", creativePrompt: "x" }))).status).toBe(400);
  });
});

describe("planning", () => {
  it("returns a valid plan whose scenes sum to the duration and fit the clip limit", async () => {
    for (const d of [4, 6, 8, 12, 30]) {
      const r = await (await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea, durationSeconds: d }))).json();
      expect(r.planner).toBe("basic");
      expect(r.plan.scenes.reduce((a: number, s: any) => a + s.durationSeconds, 0)).toBe(d);
      expect(Math.max(...r.plan.scenes.map((s: any) => s.durationSeconds))).toBeLessThanOrEqual(5);
    }
  });
  it("never charges credits", async () => {
    const before = await balance("pro");
    await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea }));
    expect(await balance("pro")).toEqual(before);
  });
});

describe("generation lifecycle", () => {
  it("runs asynchronously, ends succeeded, and charges exactly the quote", async () => {
    const before = (await balance("pro")).available;
    const { start, body } = await run("pro");
    expect(start.status).toBe(202);
    const done = await waitDone(body.id, "pro");
    expect(done.status).toBe("succeeded");
    expect(done.progress).toBe(100);
    expect(done.scenes.every((s: any) => s.state === "done")).toBe(true);
    expect(done.credits).toEqual({ quoted: 53, charged: 53, refunded: 0 });
    expect((await balance("pro")).available).toBe(before - 53);
  });

  it("a double submit with the same key gives one job and one charge", async () => {
    const before = (await balance("pro")).available;
    const p = (await (await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea }))).json()).plan;
    const k = key();
    const send = () => gens.POST(post("/api/generations", { plan: "pro", ...base, idempotencyKey: k, creativePlan: p }));
    const [a, b] = await Promise.all([send(), send()]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(ja.id).toBe(jb.id);
    await waitDone(ja.id, "pro");
    expect((await balance("pro")).available).toBe(before - 53);
  });

  it("an edited scene is what gets generated", async () => {
    const p = (await (await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea }))).json()).plan;
    p.scenes[0].action = "EDITED: the cat wears a tiny helmet";
    const r = await (await gens.POST(post("/api/generations", { plan: "pro", ...base, idempotencyKey: key(), creativePlan: p }))).json();
    const done = await waitDone(r.id, "pro");
    expect(done.scenes[0].action).toBe("EDITED: the cat wears a tiny helmet");
  });

  it("another user cannot read, regenerate or rate someone else's video", async () => {
    const { body } = await run("pro");
    await waitDone(body.id, "pro");
    const ctx = { params: Promise.resolve({ id: body.id }) };
    expect((await gen.GET(get(`/api/generations/${body.id}?plan=free`), ctx)).status).toBe(404);
    expect((await regen.POST(post("/x", { plan: "free", idempotencyKey: key() }), { params: Promise.resolve({ id: body.id, index: "0" }) })).status).toBe(404);
    expect((await rating.POST(post("/x", { plan: "free", value: "up" }), ctx)).status).toBe(404);
  });

  it("regenerating one scene charges only that scene, once per key", async () => {
    const { body } = await run("pro");
    const done = await waitDone(body.id, "pro");
    expect(done.scenes.map((s: any) => s.regenCredits)).toEqual([18, 18, 12]);
    const before = (await balance("pro")).available;
    const k = key();
    const ctx = { params: Promise.resolve({ id: body.id, index: "1" }) };
    const r = await (await regen.POST(post("/x", { plan: "pro", idempotencyKey: k }), ctx)).json();
    expect(r).toMatchObject({ ok: true, creditsCharged: 18 });
    const again = await (await regen.POST(post("/x", { plan: "pro", idempotencyKey: k }), { params: Promise.resolve({ id: body.id, index: "1" }) })).json();
    expect(again.creditsCharged).toBe(0);
    expect((await balance("pro")).available).toBe(before - 18);
    expect((await regen.POST(post("/x", { plan: "pro", idempotencyKey: key() }), { params: Promise.resolve({ id: body.id, index: "9" }) })).status).toBe(404);
  });

  it("records a rating", async () => {
    const { body } = await run("pro");
    await waitDone(body.id, "pro");
    expect((await rating.POST(post("/x", { plan: "pro", value: "down" }), { params: Promise.resolve({ id: body.id }) })).status).toBe(200);
    expect((await waitDone(body.id, "pro")).rating).toBe("down");
  });

  it("enforces plan limits and insufficient credits without charging", async () => {
    // Free plan: 30s needs a paid plan.
    const thirty = await run("free", { durationSeconds: 30 });
    expect((await waitDone(thirty.body.id, "free")).error.code).toBe("INVALID_REQUEST");
    // Free plan has 120 credits: two 53-credit videos fit, the third is refused.
    const first = await run("free"); await waitDone(first.body.id, "free");
    const second = await run("free"); await waitDone(second.body.id, "free");
    const third = await run("free");
    const t = await waitDone(third.body.id, "free");
    expect(t).toMatchObject({ status: "rejected", error: { code: "INSUFFICIENT_CREDITS" } });
    expect(await balance("free")).toMatchObject({ available: 14, held: 0, spent: 106 });
  });

  it("refuses a model the user's region isn't licensed for, at planning and at generation", async () => {
    // Gate 1: planning refuses outright.
    const refused = await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea, modelId: "hunyuan", region: "FR" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("NO_MODEL");
    // Gate 2: a request that skips planning (a plan made in India, sent from France) is rejected before any charge.
    const p = (await (await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea, modelId: "hunyuan", region: "IN" }))).json()).plan;
    const before = await balance("pro");
    const r = await (await gens.POST(post("/api/generations", { plan: "pro", ...base, modelId: "hunyuan", region: "FR", idempotencyKey: key(), creativePlan: p }))).json();
    expect(await waitDone(r.id, "pro")).toMatchObject({ status: "rejected", error: { code: "NO_MODEL" } });
    expect(await balance("pro")).toEqual(before);
  });
});

afterAll(() => { delete (globalThis as { __clipnova?: unknown }).__clipnova; });
