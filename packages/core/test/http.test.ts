import { describe, expect, it } from "vitest";
import { HttpVideoAdapter, buildPrompt, type VideoStore } from "../src/adapters/http";
import { fakeProfile } from "../src/adapters/fake";
import { ModelRegistry, type SceneRequest } from "../src/models";
import { runGeneration } from "../src/workflow";
import { makePlan, setup } from "./helpers";

const VIDEO = new Uint8Array(4096).fill(7);

interface WorkerOpts {
  /** statuses returned by successive polls */
  polls?: object[];
  createStatus?: number;
  pollStatus?: number;
  videoBytes?: Uint8Array;
  throwOnCreate?: boolean;
}

/** A stand-in for workers/inference, speaking the same HTTP protocol. */
function fakeWorker(o: WorkerOpts = {}) {
  const seen: { url: string; method: string; auth?: string; body?: any }[] = [];
  let poll = 0;
  const f = (async (input: any, init: any = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    seen.push({ url, method, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/v1/jobs" && method === "POST") {
      if (o.throwOnCreate) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ jobId: "job1" }), { status: o.createStatus ?? 202 });
    }
    if (path === "/v1/jobs/job1") {
      if (o.pollStatus) return new Response("gone", { status: o.pollStatus });
      const polls = o.polls ?? [{ status: "running", progress: 0.4 }, { status: "succeeded", progress: 1, gpuSeconds: 42 }];
      return new Response(JSON.stringify(polls[Math.min(poll++, polls.length - 1)]), { status: 200 });
    }
    if (path === "/v1/jobs/job1/video") return new Response((o.videoBytes ?? VIDEO) as unknown as BodyInit, { status: 200 });
    if (path === "/healthz") return new Response("ok");
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const store = () => {
  const saved: { key: string; bytes: Uint8Array }[] = [];
  const s: VideoStore = { async save(key, bytes) { saved.push({ key, bytes }); return `file:///data/${key}.mp4`; } };
  return { s, saved };
};
const sleep = async () => undefined;

function adapter(w: ReturnType<typeof fakeWorker>, st: VideoStore, extra: Record<string, unknown> = {}, profile = fakeProfile({ id: "wan", name: "Wan 2.2" })) {
  return new HttpVideoAdapter(profile, { baseUrl: "https://w.example/", token: "secret-token", workerModelId: "wan22-ti2v-5b", store: st, fetch: w.f, sleep, ...extra });
}

function sceneReq(over: Partial<SceneRequest> = {}): SceneRequest {
  const plan = makePlan(4, 2); // two 2s scenes
  return { generationId: "gen_1", scene: plan.scenes[0]!, plan, mode: "t2v", aspectRatio: "9:16", inputAssetIds: [], seed: 5, attempt: 1, ...over };
}

describe("HttpVideoAdapter", () => {
  it("creates a job, follows progress, downloads and stores the video", async () => {
    const w = fakeWorker(); const st = store();
    const progress: number[] = [];
    const r = await adapter(w, st.s).generate(sceneReq(), (f) => progress.push(f));
    expect(r).toMatchObject({ outputUri: "file:///data/gen_1-s0-5.mp4", durationSeconds: 2, seed: 5, gpuSeconds: 42 });
    expect(st.saved[0]!.bytes.length).toBe(4096);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    const create = w.seen.find((s) => s.method === "POST")!;
    expect(create.url).toBe("https://w.example/v1/jobs"); // trailing slash handled
    expect(create.body).toMatchObject({ model: "wan22-ti2v-5b", seconds: 2, aspectRatio: "9:16", seed: 5 });
  });

  it("sends the bearer token on every call and never puts it in the body", async () => {
    const w = fakeWorker(); const st = store();
    await adapter(w, st.s).generate(sceneReq());
    expect(w.seen.length).toBeGreaterThanOrEqual(3);
    expect(w.seen.every((s) => s.auth === "Bearer secret-token")).toBe(true);
    expect(JSON.stringify(w.seen.map((s) => s.body))).not.toContain("secret-token");
  });

  it.each([
    ["connection refused", { throwOnCreate: true }, "WORKER_UNAVAILABLE", true],
    ["queue full (429)", { createStatus: 429 }, "WORKER_UNAVAILABLE", true],
    ["server error (503)", { createStatus: 503 }, "WORKER_UNAVAILABLE", true],
    ["rejected request (422)", { createStatus: 422 }, "WORKER_REJECTED", false],
    ["unknown model (404)", { createStatus: 404 }, "WORKER_REJECTED", false],
    ["worker lost the job", { pollStatus: 404 }, "WORKER_LOST_JOB", true],
    ["poll error (500)", { pollStatus: 500 }, "WORKER_UNAVAILABLE", true],
    ["model OOM, retryable", { polls: [{ status: "failed", error: { code: "OOM", message: "out of memory", retryable: true } }] }, "OOM", true],
    ["model refused, not retryable", { polls: [{ status: "failed", error: { code: "BAD_INPUT", retryable: false } }] }, "BAD_INPUT", false],
    ["empty video", { videoBytes: new Uint8Array(10) }, "EMPTY_VIDEO", true],
  ] as const)("%s -> %s (retryable=%s)", async (_name, opts, code, retryable) => {
    const st = store();
    await expect(adapter(fakeWorker(opts as WorkerOpts), st.s).generate(sceneReq())).rejects.toMatchObject({ name: "ModelError", code, retryable });
    expect(st.saved).toHaveLength(0);
  });

  it("gives up after the timeout", async () => {
    const w = fakeWorker({ polls: [{ status: "running", progress: 0.1 }] });
    await expect(adapter(w, store().s, { timeoutMs: 0 }).generate(sceneReq())).rejects.toMatchObject({ code: "WORKER_TIMEOUT", retryable: true });
  });

  it("validates mode, aspect ratio, clip length and the missing-upload case before any call", () => {
    const a = adapter(fakeWorker(), store().s, {}, fakeProfile({ modes: ["t2v", "i2v"], aspectRatios: ["16:9"], maxClipSeconds: 3 }));
    expect(a.validate(sceneReq({ aspectRatio: "9:16" })).some((i) => i.includes("9:16"))).toBe(true);
    expect(a.validate(sceneReq({ aspectRatio: "16:9", mode: "i2v" })).some((i) => i.includes("uploaded"))).toBe(true);
    expect(a.validate(sceneReq({ aspectRatio: "16:9", mode: "v2v" })).some((i) => i.includes("v2v"))).toBe(true);
    const long = makePlan(8, 8);
    expect(a.validate(sceneReq({ aspectRatio: "16:9", scene: long.scenes[0]!, plan: long })).some((i) => i.includes("at most 3s"))).toBe(true);
    expect(a.validate(sceneReq({ aspectRatio: "16:9" }))).toEqual([]);
  });

  it("translates non-English scenes before they reach the model, and survives a translator failure", async () => {
    const plan = { ...makePlan(4), inputLanguage: "hi" };
    const req = sceneReq({ plan, scene: { ...plan.scenes[0]!, action: "रिया स्कूटर पर भागती है" } });
    let w = fakeWorker();
    await adapter(w, store().s, { translate: async (t: string, from: string) => `EN(${from}): ${t.length} chars` }).generate(req);
    expect(w.seen.find((s) => s.method === "POST")!.body.prompt).toContain("EN(hi):");
    w = fakeWorker();
    await adapter(w, store().s, { translate: async () => { throw new Error("down"); } }).generate(req);
    expect(w.seen.find((s) => s.method === "POST")!.body.prompt).toContain("रिया");
    // English input is never translated
    w = fakeWorker();
    let called = false;
    await adapter(w, store().s, { translate: async (t: string) => { called = true; return t; } }).generate(sceneReq());
    expect(called).toBe(false);
  });

  it("healthcheck reflects the worker", async () => {
    expect(await adapter(fakeWorker(), store().s).healthcheck()).toBe(true);
    const down = adapter({ f: (async () => { throw new Error("x"); }) as unknown as typeof fetch, seen: [] }, store().s);
    expect(await down.healthcheck()).toBe(false);
  });
});

describe("buildPrompt", () => {
  it("puts action first and the creative prompt last, with characters, setting and camera in between", () => {
    const plan = makePlan(4);
    plan.setting = { location: "Pune street", timeOfDay: "early morning", lighting: "golden light", visualStyle: "realistic vlog" };
    plan.rawInput.creativePrompt = "handheld, bright";
    const scene = { ...plan.scenes[0]!, action: "Riya races a scooter.", camera: "low-angle whip pans", motion: "energetic" };
    const p = buildPrompt(sceneReq({ plan, scene }));
    expect(p.startsWith("Riya races a scooter")).toBe(true);
    expect(p).toContain("Characters: Momo, orange tabby cat");
    expect(p).toContain("Pune street, early morning, golden light");
    expect(p).toContain("Camera: low-angle whip pans");
    expect(p.endsWith("handheld, bright")).toBe(true);
    expect(p.indexOf("Camera:")).toBeLessThan(p.indexOf("handheld"));
  });
  it("omits empty parts and caps the length", () => {
    const plan = makePlan(4);
    plan.rawInput.creativePrompt = "x".repeat(5000);
    const p = buildPrompt(sceneReq({ plan }));
    expect(p.length).toBeLessThanOrEqual(1800);
    expect(p).not.toContain("Camera:");
    expect(p).not.toContain("..");
  });
});

describe("HttpVideoAdapter inside the generation workflow", () => {
  function wf(adapters: HttpVideoAdapter[]) {
    const t = setup();
    const reg = new ModelRegistry();
    adapters.forEach((a) => reg.register(a));
    t.deps.registry = reg;
    return t;
  }

  it("a successful worker run charges credits and a failed one refunds them", async () => {
    const good = adapter(fakeWorker(), store().s, {}, fakeProfile({ id: "wan", name: "Wan 2.2" }));
    const t = wf([good]);
    await t.ledger.grant("u1", 100, "g");
    const g = await runGeneration(t.deps, t.req({ duration: 4 }));
    expect(g.status).toBe("succeeded");
    expect(g.scenes.every((s) => s.result?.outputUri.startsWith("file:///data/"))).toBe(true);
    expect((await t.ledger.balance("u1")).held).toBe(0);

    const bad = adapter(fakeWorker({ createStatus: 503 }), store().s, {}, fakeProfile({ id: "wan", name: "Wan 2.2" }));
    const t2 = wf([bad]);
    await t2.ledger.grant("u1", 100, "g");
    const g2 = await runGeneration(t2.deps, t2.req({ duration: 4 }));
    expect(g2.status).toBe("failed");
    expect(await t2.ledger.balance("u1")).toEqual({ available: 100, held: 0, spent: 0 });
  });

  it("falls back to the next model when the first rejects the request", async () => {
    const rejecting = adapter(fakeWorker({ createStatus: 422 }), store().s, {}, fakeProfile({ id: "a-first", name: "A", creditsPerSecond: 3 }));
    const working = adapter(fakeWorker(), store().s, {}, fakeProfile({ id: "b-second", name: "B", creditsPerSecond: 4 }));
    const t = wf([rejecting, working]);
    await t.ledger.grant("u1", 100, "g");
    const g = await runGeneration(t.deps, t.req({ duration: 4 }));
    expect(g.status).toBe("succeeded");
    expect(g.scenes[0]!.modelId).toBe("b-second");
    expect(g.scenes[0]!.attempts).toBe(2); // one non-retryable rejection, then the fallback
  });
});
