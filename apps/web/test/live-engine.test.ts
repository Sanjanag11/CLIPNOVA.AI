import { DEFAULT_PLANS, planCreative } from "@clipnova/core";
import { beforeAll, describe, expect, it } from "vitest";
import { openEmbeddedDb, type Db } from "../lib/db";
import { buildLiveEngine } from "../lib/engines/live";
import type { Caller, StartInput } from "../lib/engines/types";
import type { FileStore } from "../lib/files";
import type { LiveEngine } from "../lib/live/engine";
import { ApiError } from "../lib/errors";

type SceneState = "queued" | "rendering" | "retrying" | "done" | "failed";
interface FakeVideo {
  status: "queued" | "running" | "composing" | "succeeded" | "failed";
  scenes: { index: number; state: SceneState; progress: number; attempt: number; revision: number; error?: { code: string } }[];
  regens: Record<string, "running" | "succeeded" | "failed">;
  error?: { code: string; message: string };
  body: { model: string; aspectRatio: string; watermark: boolean; scenes: { prompt: string; seconds: number }[] };
}

/** A scripted stand-in for the GPU worker, speaking its real HTTP protocol. */
class FakeWorker {
  videos = new Map<string, FakeVideo>();
  n = 0;
  mode: "up" | "down" | "forgot" = "up";
  createStatus = 202;
  fileFailures = 0;
  regenStatus = 202;
  served = ["ltx-video", "wan22-ti2v-5b"];
  readonly fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code });
    if (this.mode === "down") throw new Error("ECONNREFUSED");
    if (url.pathname === "/v1/models") return json(200, { models: this.served.map((id) => ({ id })) });
    if (url.pathname === "/v1/videos" && method === "POST") {
      if (this.createStatus !== 202) return json(this.createStatus, { detail: "no" });
      const body = JSON.parse(String(init.body));
      const id = `v${++this.n}`;
      this.videos.set(id, { status: "running", body, regens: {}, scenes: body.scenes.map((_: unknown, index: number) => ({ index, state: "queued", progress: 0, attempt: 0, revision: 0 })) });
      return json(202, { videoId: id });
    }
    const m = url.pathname.match(/^\/v1\/videos\/(v\d+)(\/video|\/scenes\/(\d+)\/regenerate)?$/);
    const v = m && this.mode !== "forgot" ? this.videos.get(m[1]!) : undefined;
    if (!m || !v) return json(404, { detail: "no such video" });
    if (m[2] === "/video") {
      if (this.fileFailures > 0) { this.fileFailures--; return json(503, { detail: "busy" }); }
      return new Response(new Uint8Array(2048).fill(9));
    }
    if (m[2]) {
      if (this.regenStatus !== 202) return json(this.regenStatus, { detail: "busy" });
      const rid = `r${Object.keys(v.regens).length + 1}`;
      v.regens[rid] = "running";
      return json(202, { regenId: rid });
    }
    return json(200, { status: v.status, progress: v.status === "succeeded" ? 1 : 0.4, gpuSeconds: 3, scenes: v.scenes, regens: v.regens, ...(v.error ? { error: v.error } : {}) });
  }) as typeof fetch;

  last() { return this.videos.get(`v${this.n}`)!; }
  succeed(states: SceneState[] = ["done", "done", "done"]) {
    const v = this.last();
    v.scenes.forEach((s, i) => Object.assign(s, { state: states[i] ?? "done", progress: 1, attempt: 1, revision: states[i] === "failed" ? 0 : 1 }));
    v.status = "succeeded";
  }
}

let db: Db;
beforeAll(async () => { db = await openEmbeddedDb(); }, 60_000);

const memoryFiles = () => {
  const saved: string[] = [];
  const files: FileStore = { async put(name) { saved.push(name); return `https://blob.example/${name}`; } };
  return { files, saved };
};

let u = 0;
async function setup(opts: { now?: () => number; workerLossMs?: number; jobTimeoutMs?: number; plan?: number; credits?: number; models?: string[] } = {}) {
  const w = new FakeWorker();
  const { files, saved } = memoryFiles();
  const eng = await buildLiveEngine({ workerUrl: "https://gpu.example", workerToken: "t", db, files, fetch: w.fetch, models: opts.models ?? ["ltx", "wan"], now: opts.now, workerLossMs: opts.workerLossMs, jobTimeoutMs: opts.jobTimeoutMs });
  const c: Caller = { userId: `user-${++u}`, plan: DEFAULT_PLANS[opts.plan ?? 1]!, region: "IN", bucket: 0 };
  await eng.ledger.grant(c.userId, opts.credits ?? 900, `grant:${c.userId}`);
  return { w, eng, c, saved };
}

let k = 0;
const input = (over: Partial<StartInput> = {}, seconds = 8): StartInput => ({
  idempotencyKey: `key-${++k}-padding`, mode: "t2v", durationSeconds: seconds, aspectRatio: "9:16", modelId: "ltx",
  addons: { voice: false, music: false, sfx: false },
  creativePlan: planCreative({ description: "A cat learns to skateboard. It falls, then it tries again, and finally it rolls down the street.", creativePrompt: "bright and funny", durationSeconds: seconds, maxClipSeconds: 5 }),
  ...over,
});
const view = async (eng: LiveEngine, c: Caller, id: string) => (await eng.view(c, id))!;
const bal = (eng: LiveEngine, c: Caller) => eng.ledger.balance(c.userId);

describe("starting a video", () => {
  it("reserves credits, hands the job to the worker and returns immediately", async () => {
    const { w, eng, c } = await setup();
    const { id, status } = await eng.start(c, input());
    expect(status).toBe("running");
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 24, spent: 0 });
    const body = w.last().body;
    expect(body).toMatchObject({ model: "ltx-video", aspectRatio: "9:16", watermark: false });
    expect(body.scenes.map((s) => s.seconds)).toEqual([3, 3, 2]);
    expect(body.scenes[0]!.prompt).toContain("bright and funny");        // English prompt built from the plan
    const v = await view(eng, c, id);
    expect(v).toMatchObject({ status: "running", stage: "rendering", credits: { quoted: 24, charged: 0, refunded: 0 } });
    expect(v.quote!.lines).toEqual([{ label: "Video · LTX-Video · 8s", credits: 24 }]);    // no audio is quoted or charged
  });

  it("a free-plan video asks the worker for the watermark; paid plans do not", async () => {
    const free = await setup({ plan: 0 });
    await free.eng.start(free.c, input({}, 4));
    expect(free.w.last().body.watermark).toBe(true);
    const paid = await setup({ plan: 1 });
    await paid.eng.start(paid.c, input({}, 4));
    expect(paid.w.last().body.watermark).toBe(false);
  });

  it("a double submit with the same key gives one job and one reservation", async () => {
    const { w, eng, c } = await setup();
    const i = input();
    const [a, b, d] = await Promise.all([eng.start(c, i), eng.start(c, i), eng.start(c, i)]);
    expect(new Set([a.id, b.id, d.id]).size).toBe(1);
    expect(w.n).toBe(1);
    expect((await bal(eng, c)).held).toBe(24);
  });

  it.each([
    ["not enough credits", { credits: 10 }, input(), "INSUFFICIENT_CREDITS"],
    ["30 s on the free plan", { plan: 0 }, input({}, 30), "INVALID_REQUEST"],
    ["scene lengths that don't add up", {}, { ...input(), durationSeconds: 6 }, "INVALID_REQUEST"],
    ["a model the worker doesn't have", {}, input({ modelId: "hunyuan" }), "NO_MODEL"],
    ["image-to-video (no uploads yet)", {}, input({ mode: "i2v" }), "NO_MODEL"],
  ] as const)("rejects %s without charging", async (_n, opts, i, code) => {
    const { w, eng, c } = await setup(opts);
    const before = await bal(eng, c);
    const { id, status } = await eng.start(c, i as StartInput);
    expect(status).toBe("rejected");
    expect((await view(eng, c, id)).error!.code).toBe(code);
    expect(await bal(eng, c)).toEqual(before);
    expect(w.n).toBe(0);                                              // the worker was never bothered
  });

  it("enforces the plan's concurrency limit", async () => {
    const { eng, c } = await setup({ plan: 0 });                       // free plan: one at a time
    await eng.start(c, input({}, 4));
    const second = await eng.start(c, input({}, 4));
    expect((await view(eng, c, second.id)).error!.code).toBe("CONCURRENCY_LIMIT");
  });

  it.each([[503, "WORKER_UNAVAILABLE"], [429, "WORKER_UNAVAILABLE"], [422, "WORKER_REJECTED"]])("a worker that answers %i refunds the reservation (%s)", async (status, code) => {
    const { w, eng, c } = await setup();
    w.createStatus = status;
    const { id, status: st } = await eng.start(c, input());
    expect(st).toBe("failed");
    expect((await view(eng, c, id)).error!.code).toBe(code);
    expect(await bal(eng, c)).toEqual({ available: 900, held: 0, spent: 0 });
  });

  it("an unreachable worker refunds the reservation", async () => {
    const { w, eng, c } = await setup();
    w.mode = "down";
    expect((await eng.start(c, input())).status).toBe("failed");
    expect(await bal(eng, c)).toEqual({ available: 900, held: 0, spent: 0 });
  });
});

describe("following a video to the end", () => {
  it("success: stores the video, charges every scene once, shows progress along the way", async () => {
    const { w, eng, c, saved } = await setup();
    const { id } = await eng.start(c, input());
    w.last().scenes[0]!.state = "rendering"; w.last().scenes[0]!.progress = 0.5;
    const mid = await view(eng, c, id);
    expect(mid.scenes.map((s) => s.state)).toEqual(["rendering", "queued", "queued"]);
    expect(mid.status).toBe("running");
    w.succeed();
    const done = await view(eng, c, id);
    expect(done).toMatchObject({ status: "succeeded", stage: "done", progress: 100, credits: { quoted: 24, charged: 24, refunded: 0 } });
    expect(done.outputUri).toMatch(/^https:\/\/blob\.example\/gen_.*\.mp4$/);
    expect(saved).toHaveLength(1);
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
    await view(eng, c, id); await view(eng, c, id);                  // further checks change nothing
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
    expect(saved).toHaveLength(1);
  });

  it("five simultaneous status checks settle the credits exactly once", async () => {
    const { w, eng, c, saved } = await setup();
    const { id } = await eng.start(c, input());
    w.succeed();
    const views = await Promise.all(Array.from({ length: 5 }, () => eng.view(c, id)));
    expect(views.every((v) => v !== null)).toBe(true);
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
    expect(saved).toHaveLength(1);
    expect((await view(eng, c, id)).credits).toEqual({ quoted: 24, charged: 24, refunded: 0 });
  });

  it("partial: charges the scenes that were delivered and refunds the one that wasn't", async () => {
    const { w, eng, c } = await setup();
    const { id } = await eng.start(c, input());
    w.succeed(["done", "failed", "done"]);
    const v = await view(eng, c, id);
    expect(v.status).toBe("partial");
    expect(v.scenes.map((s) => s.state)).toEqual(["done", "failed", "done"]);
    expect(v.credits).toEqual({ quoted: 24, charged: 15, refunded: 9 });          // scenes cost 9 / 9 / 6
    expect(await bal(eng, c)).toEqual({ available: 900 - 15, held: 0, spent: 15 });
  });

  it("a worker failure refunds everything and says why", async () => {
    const { w, eng, c } = await setup();
    const { id } = await eng.start(c, input());
    Object.assign(w.last(), { status: "failed", error: { code: "OOM", message: "the GPU ran out of memory" } });
    const v = await view(eng, c, id);
    expect(v).toMatchObject({ status: "failed", error: { code: "OOM", reasons: ["the GPU ran out of memory"] }, outputUri: undefined });
    expect(await bal(eng, c)).toEqual({ available: 900, held: 0, spent: 0 });
  });

  it("a worker that restarted and forgot the video refunds everything", async () => {
    const { w, eng, c } = await setup();
    const { id } = await eng.start(c, input());
    w.mode = "forgot";
    const v = await view(eng, c, id);
    expect(v).toMatchObject({ status: "failed", error: { code: "WORKER_LOST_JOB" } });
    expect(await bal(eng, c)).toEqual({ available: 900, held: 0, spent: 0 });
  });

  it("short outages are tolerated; a long one refunds", async () => {
    let t = 1_000_000;
    const { w, eng, c } = await setup({ now: () => t, workerLossMs: 180_000 });
    const { id } = await eng.start(c, input());
    w.mode = "down";
    t += 60_000;
    expect((await view(eng, c, id)).status).toBe("running");          // a blip
    w.mode = "up"; w.succeed();
    t += 1000;
    expect((await view(eng, c, id)).status).toBe("succeeded");        // and it recovered
    const second = await setup({ now: () => t, workerLossMs: 180_000 });
    const s2 = await second.eng.start(second.c, input());
    second.w.mode = "down";
    t += 200_000;
    expect(await view(second.eng, second.c, s2.id)).toMatchObject({ status: "failed", error: { code: "WORKER_UNAVAILABLE" } });
    expect(await bal(second.eng, second.c)).toEqual({ available: 900, held: 0, spent: 0 });
  });

  it("a video that takes too long is failed and refunded", async () => {
    let t = 5_000_000;
    const { eng, c } = await setup({ now: () => t, jobTimeoutMs: 600_000 });
    const { id } = await eng.start(c, input());
    t += 601_000;
    expect(await view(eng, c, id)).toMatchObject({ status: "failed", error: { code: "WORKER_TIMEOUT" } });
    expect(await bal(eng, c)).toEqual({ available: 900, held: 0, spent: 0 });
  });

  it("a job that was reserved but never handed to the worker (the function died) is refunded", async () => {
    let t = 9_000_000;
    const { eng, c } = await setup({ now: () => t });
    const { id } = await eng.start(c, input());
    await db.query("UPDATE generations SET data = data - 'workerVideoId' WHERE id = $1", [id]);   // simulate the crash
    t += 3 * 60_000;
    expect(await view(eng, c, id)).toMatchObject({ status: "failed", error: { code: "WORKER_UNAVAILABLE" } });
    expect(await bal(eng, c)).toEqual({ available: 900, held: 0, spent: 0 });
  });

  it("if storing the video fails, the next check retries and still settles once", async () => {
    const { w, eng, c, saved } = await setup();
    const { id } = await eng.start(c, input());
    w.succeed();
    w.fileFailures = 1;
    expect((await view(eng, c, id)).status).toBe("running");          // not finished until the video is safely stored
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 24, spent: 0 });
    expect((await view(eng, c, id)).status).toBe("succeeded");
    expect(saved).toHaveLength(1);
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
  });
});

describe("regenerating one scene", () => {
  async function finished() {
    const t = await setup();
    const { id } = await t.eng.start(t.c, input());
    t.w.succeed();
    await view(t.eng, t.c, id);
    return { ...t, id };
  }

  it("charges only that scene, shows it busy, then swaps in the new video", async () => {
    const { w, eng, c, id, saved } = await finished();
    const r = await eng.regenerate(c, id, 1, "regen-a");
    expect(r).toMatchObject({ ok: true, pending: true, creditsCharged: 0 });
    expect(await bal(eng, c)).toEqual({ available: 900 - 24 - 9, held: 9, spent: 24 });     // reserved, not yet spent
    expect(w.last().regens).toEqual({ r1: "running" });
    let v = await view(eng, c, id);
    expect(v.scenes[1]).toMatchObject({ state: "rendering", busy: true, regenCredits: 9 });
    expect(v.scenes[0]!.busy).toBe(false);

    w.last().regens.r1 = "succeeded"; w.last().scenes[1]!.revision = 2;
    v = await view(eng, c, id);
    expect(v.status).toBe("succeeded");
    expect(v.scenes[1]).toMatchObject({ state: "done", busy: false });
    expect(v.credits).toEqual({ quoted: 24, charged: 33, refunded: 0 });
    expect(await bal(eng, c)).toEqual({ available: 900 - 33, held: 0, spent: 33 });
    expect(saved).toHaveLength(2);                                      // a second stitched video
    expect(v.outputUri).toContain(saved[1]!);
  });

  it("a failed regeneration is refunded and the video stays as it was", async () => {
    const { w, eng, c, id } = await finished();
    const before = (await view(eng, c, id)).outputUri;
    await eng.regenerate(c, id, 0, "regen-b");
    w.last().regens.r1 = "failed";
    const v = await view(eng, c, id);
    expect(v).toMatchObject({ status: "succeeded", outputUri: before, credits: { charged: 24 } });
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
  });

  it("the same key charges once; a second scene can't start while one is running", async () => {
    const { eng, c, id } = await finished();
    await eng.regenerate(c, id, 0, "same");
    const again = await eng.regenerate(c, id, 0, "same");
    expect(again.pending).toBe(true);
    expect((await bal(eng, c)).held).toBe(9);
    await expect(eng.regenerate(c, id, 1, "other")).rejects.toMatchObject({ status: 409, code: "SCENE_BUSY" });
    expect((await bal(eng, c)).held).toBe(9);
  });

  it("is refused for an unfinished video, a missing scene, someone else's video, or without credits", async () => {
    const t = await setup();
    const { id } = await t.eng.start(t.c, input());
    await expect(t.eng.regenerate(t.c, id, 0, "k1")).rejects.toMatchObject({ status: 409, code: "NOT_FINISHED" });
    t.w.succeed();
    await view(t.eng, t.c, id);
    await expect(t.eng.regenerate(t.c, id, 9, "k2")).rejects.toMatchObject({ status: 404, code: "BAD_SCENE" });
    const stranger: Caller = { ...t.c, userId: "someone-else" };
    await expect(t.eng.regenerate(stranger, id, 0, "k3")).rejects.toMatchObject({ status: 404 });
    // spend nearly everything, then try again
    await t.eng.ledger.reserve(t.c.userId, "burn", (await bal(t.eng, t.c)).available - 5, "burn-key");
    await expect(t.eng.regenerate(t.c, id, 0, "k4")).rejects.toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
    expect(t.w.last().regens).toEqual({});
  });

  it("a worker that can't take the regeneration refunds it", async () => {
    const { w, eng, c, id } = await finished();
    w.regenStatus = 503;
    await expect(eng.regenerate(c, id, 0, "k5")).rejects.toMatchObject({ status: 503, code: "WORKER_UNAVAILABLE" });
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
    w.regenStatus = 409;
    await expect(eng.regenerate(c, id, 0, "k6")).rejects.toBeInstanceOf(ApiError);
    expect(await bal(eng, c)).toEqual({ available: 900 - 24, held: 0, spent: 24 });
  });
});

describe("access and ratings", () => {
  it("only the owner can see a video or rate it", async () => {
    const { w, eng, c } = await setup();
    const { id } = await eng.start(c, input());
    w.succeed(); await view(eng, c, id);
    const stranger: Caller = { ...c, userId: "someone-else" };
    expect(await eng.view(stranger, id)).toBeNull();
    expect(await eng.view(c, "gen_unknown")).toBeNull();
    expect(await eng.rate(stranger, id, "up")).toBe(false);
    expect(await eng.rate(c, id, "up")).toBe(true);
    expect((await view(eng, c, id)).rating).toBe("up");
    await eng.rate(c, id, "down");
    expect((await view(eng, c, id)).rating).toBe("down");
  });
});

describe("model discovery", () => {
  it("switches off models the worker does not actually serve", async () => {
    const { w, eng } = await setup();
    expect(eng.registry.list().every((r) => r.enabled)).toBe(true);
    w.served = ["ltx-video"];
    await eng.refresh();
    expect(Object.fromEntries(eng.registry.list().map((r) => [r.adapter.profile.id, r.enabled]))).toEqual({ ltx: true, wan: false });
  });
  it("leaves things alone when the worker can't be reached", async () => {
    const { w, eng } = await setup();
    w.mode = "down";
    await eng.refresh();
    expect(eng.registry.list().every((r) => r.enabled)).toBe(true);
  });
});
