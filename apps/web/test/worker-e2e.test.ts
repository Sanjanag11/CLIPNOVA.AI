import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The full live path with only the GPU stubbed: API -> workflow -> HttpVideoAdapter -> (stand-in worker returning
 * real mp4 files) -> LocalVideoStore -> FfmpegComposer -> served video.
 */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "clipnova-e2e-"));
const TOKEN = "test-worker-token";
process.env.CLIPNOVA_DATA_DIR = dir;
process.env.CLIPNOVA_DEMO = "1";
process.env.CLIPNOVA_WORKER_TOKEN = TOKEN;
process.env.CLIPNOVA_POLL_MS = "20";

type Handler = (req: Request, ctx?: any) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any
let server: Server;
const received: { model: string; prompt: string; seconds: number; aspectRatio: string; auth?: string }[] = [];
const behavior = { failModels: new Set<string>(), failRetryable: true };
let me: { GET: Handler }, models: { GET: Handler }, plan: { POST: Handler }, gens: { POST: Handler }, gen: { GET: Handler }, videos: { GET: Handler };

function clip(seconds: number, w: number, h: number, fps: number): Buffer {
  const out = join(dir, `tmp-${Math.random().toString(36).slice(2)}.mp4`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds}`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  return Buffer.from(require("node:fs").readFileSync(out));
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  const jobs = new Map<string, { model: string; polls: number; seconds: number; aspect: string }>();
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const auth = req.headers.authorization;
    const send = (code: number, body: unknown, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    if (auth !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
    if (url.pathname === "/healthz") return send(200, "ok", "text/plain");
    if (url.pathname === "/v1/models") return send(200, { models: [{ id: "wan22-ti2v-5b" }, { id: "ltx-video" }] }); // does NOT serve cogvideox
    if (url.pathname === "/v1/jobs" && req.method === "POST") {
      let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
        const b = JSON.parse(raw);
        received.push({ model: b.model, prompt: b.prompt, seconds: b.seconds, aspectRatio: b.aspectRatio, auth });
        const id = `job${jobs.size + 1}`;
        jobs.set(id, { model: b.model, polls: 0, seconds: b.seconds, aspect: b.aspectRatio });
        send(202, { jobId: id });
      });
      return;
    }
    const m = url.pathname.match(/^\/v1\/jobs\/(job\d+)(\/video)?$/);
    const job = m && jobs.get(m[1]!);
    if (!job) return send(404, { error: "no such job" });
    if (m![2]) { const [w, h] = job.aspect === "16:9" ? [1280, 704] : [704, 1280]; return send(200, clip(job.seconds, w, h, 24), "video/mp4"); }
    job.polls++;
    if (behavior.failModels.has(job.model)) return send(200, { status: "failed", error: { code: "OOM", message: "out of memory", retryable: behavior.failRetryable } });
    return send(200, job.polls < 2 ? { status: "running", progress: 0.5 } : { status: "succeeded", progress: 1, gpuSeconds: 12 });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.CLIPNOVA_WORKER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  me = await import("../app/api/me/route"); models = await import("../app/api/models/route"); plan = await import("../app/api/plan/route");
  gens = await import("../app/api/generations/route"); gen = await import("../app/api/generations/[id]/route"); videos = await import("../app/api/videos/[name]/route");
});
afterAll(async () => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const itf = it.skipIf(!hasFfmpeg);
const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://x${url}`);
const base = { mode: "t2v", durationSeconds: 8, aspectRatio: "9:16", addons: { voice: false, music: false, sfx: false } };
const idea = { description: "A cat learns to skateboard. It falls, then it tries again, and finally it rolls down the street.", creativePrompt: "bright and funny", language: "en" };
let n = 0;

async function run(planId: string, over: Record<string, unknown> = {}) {
  const p = await (await plan.POST(post("/api/plan", { plan: planId, ...base, ...idea, ...over }))).json();
  const start = await gens.POST(post("/api/generations", { plan: planId, ...base, ...over, idempotencyKey: `e2e-key-${++n}-padding`, creativePlan: p.plan }));
  const { id } = await start.json();
  for (let i = 0; i < 400; i++) {
    const d = await (await gen.GET(get(`/api/generations/${id}?plan=${planId}`), { params: Promise.resolve({ id }) })).json();
    if (d.status !== "running") return d;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("did not finish");
}
const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", file]).toString());

describe("live engine (stand-in worker returning real video)", { timeout: 60_000 }, () => {
  itf("reports the worker engine and only the models the worker serves", async () => {
    const meRes = await (await me.GET(get("/api/me?plan=pro"))).json();
    expect(meRes.engine).toBe("worker");
    const list = (await (await models.GET(get("/api/models?plan=pro&mode=t2v&aspect=9:16"))).json()).models as { id: string; available: boolean; reason?: string }[];
    const by = (id: string) => list.find((m) => m.id === id)!;
    expect(by("wan").available).toBe(true);
    expect(by("ltx").available).toBe(true);
    expect(by("cog")).toMatchObject({ available: false, reason: "Temporarily unavailable" }); // worker doesn't serve it
    for (const id of ["hunyuan", "vace", "svd", "longcat", "mochi", "opensora"]) expect(by(id)).toMatchObject({ available: false, reason: "Coming soon" });
    const img = (await (await models.GET(get("/api/models?plan=pro&mode=i2v&aspect=9:16"))).json()).models;
    expect(img.find((m: { id: string }) => m.id === "wan")).toMatchObject({ available: false });
  });

  itf("does not charge for audio the live engine cannot produce", async () => {
    const all = { voice: true, music: true, sfx: true };
    const q = await (await (await import("../app/api/quote/route")).POST(post("/api/quote", { plan: "pro", ...base, addons: all }))).json();
    expect(q.audioAvailable).toBe(false);
    expect(q.quote.lines.map((l: { label: string }) => l.label)).toEqual(["Video · Wan 2.2 · 8s"]);
    expect(q.quote.total).toBe(48); // video only
    const d = await run("pro", { addons: all, durationSeconds: 4 });
    expect(d.credits.quoted).toBe(24);
    expect(d.credits.charged).toBe(24);
  });

  itf("renders a real video end to end and charges the quote", async () => {
    const before = (await (await me.GET(get("/api/me?plan=pro"))).json()).balance.available;
    const d = await run("pro");
    expect(d.status).toBe("succeeded");
    expect(d.outputUri).toMatch(/^\/api\/videos\/gen_\d+-[0-9a-f-]{36}\.mp4$/);
    // 8s over 3 scenes of 3+3+2s, all from the stand-in worker, stitched to one portrait 720p file
    expect(received.slice(-3).map((r) => r.seconds)).toEqual([3, 3, 2]);
    expect(received.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(received.at(-1)!.model).toBe("wan22-ti2v-5b"); // Auto picks Wan first
    expect(received.at(-1)!.prompt).toContain("bright and funny");
    const res = await videos.GET(get(d.outputUri), { params: Promise.resolve({ name: d.outputUri.split("/").pop() }) });
    expect(res.status).toBe(200);
    const file = join(dir, "videos", d.outputUri.split("/").pop());
    expect(statSync(file).size).toBeGreaterThan(1000);
    const p = probe(file);
    expect(p.streams[0]).toMatchObject({ width: 720, height: 1280, codec_name: "h264" });
    expect(Number(p.format.duration)).toBeGreaterThan(7.6);
    expect(Number(p.format.duration)).toBeLessThan(8.4);
    const after = (await (await me.GET(get("/api/me?plan=pro"))).json()).balance;
    expect(before - after.available).toBe(d.credits.charged);
    expect(after.held).toBe(0);
  });

  itf("a model that fails non-retryably falls back to the next one, with one charge", async () => {
    behavior.failModels = new Set(["wan22-ti2v-5b"]); behavior.failRetryable = false;
    try {
      const before = (await (await me.GET(get("/api/me?plan=pro"))).json()).balance.available;
      const d = await run("pro", { durationSeconds: 4 });
      expect(d.status).toBe("succeeded");
      expect(d.scenes.every((s: { modelId?: string }) => s.modelId === "ltx")).toBe(true);
      expect(before - (await (await me.GET(get("/api/me?plan=pro"))).json()).balance.available).toBe(d.credits.charged);
    } finally { behavior.failModels = new Set(); behavior.failRetryable = true; }
  });

  itf("when every model fails, the video fails and every credit is returned", async () => {
    behavior.failModels = new Set(["wan22-ti2v-5b", "ltx-video"]);
    try {
      const before = await (await me.GET(get("/api/me?plan=creator"))).json();
      const d = await run("creator", { durationSeconds: 4 });
      expect(d.status).toBe("failed");
      expect(d.credits).toMatchObject({ charged: 0 });
      expect(d.outputUri).toBeUndefined();
      expect((await (await me.GET(get("/api/me?plan=creator"))).json()).balance).toEqual(before.balance);
    } finally { behavior.failModels = new Set(); }
  });

  itf("an unreachable worker fails the video and refunds instead of hanging", async () => {
    const svc = (globalThis as { __clipnova?: { workerUrl?: string; registry: { list(): { adapter: { o: { baseUrl: string } } }[] } } }).__clipnova!;
    const rows = svc.registry.list().map((r) => r.adapter.o);
    const saved = rows.map((o) => o.baseUrl);
    rows.forEach((o) => (o.baseUrl = "http://127.0.0.1:9")); // nothing listens here
    try {
      const before = (await (await me.GET(get("/api/me?plan=pro"))).json()).balance;
      const d = await run("pro", { durationSeconds: 4 });
      expect(d.status).toBe("failed");
      expect((await (await me.GET(get("/api/me?plan=pro"))).json()).balance).toEqual(before);
    } finally { rows.forEach((o, i) => (o.baseUrl = saved[i]!)); }
  }, 60_000);
});
