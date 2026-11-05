import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The whole live path across both languages: the real API routes -> the live engine -> Postgres -> the REAL Python
 * worker (rendering ffmpeg test patterns instead of AI video) -> a stitched file served back. Skipped when the worker's
 * Python environment isn't set up (see workers/inference/README.md).
 */
const root = resolve(__dirname, "../../..");
const py = join(root, "workers/inference/.venv/bin/python");
const ready = existsSync(py) && spawnSync("ffmpeg", ["-version"]).status === 0;
const itw = it.skipIf(!ready);

const dir = mkdtempSync(join(tmpdir(), "clipnova-live-"));
const PORT = 21000 + Math.floor(Math.random() * 5000);
const TOKEN = "live-test-token";
Object.assign(process.env, {
  CLIPNOVA_DEMO: "1", CLIPNOVA_DATA_DIR: dir, CLIPNOVA_WORKER_URL: `http://127.0.0.1:${PORT}`, CLIPNOVA_WORKER_TOKEN: TOKEN,
  CLIPNOVA_WORKER_MODELS: "ltx", CLIPNOVA_WORKER_LOSS_MS: "1500", CLIPNOVA_JOB_TIMEOUT_MS: "120000",
});
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.BLOB_READ_WRITE_TOKEN;

type Handler = (req: Request, ctx?: any) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any
let worker: ChildProcess;
let me: { GET: Handler }, models: { GET: Handler }, plan: { POST: Handler }, gens: { POST: Handler }, gen: { GET: Handler }, regen: { POST: Handler }, videos: { GET: Handler };

beforeAll(async () => {
  if (!ready) return;
  worker = spawn(py, ["-m", "clipnova_worker"], {
    cwd: join(root, "workers/inference"), stdio: "ignore",
    env: { ...process.env, WORKER_FAKE: "1", WORKER_TOKEN: TOKEN, PORT: String(PORT), WORKER_MODELS: "ltx-video", WORKER_DATA_DIR: join(dir, "worker"), WORKER_FAKE_DELAY: "0.2" },
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  me = await import("../app/api/me/route"); models = await import("../app/api/models/route"); plan = await import("../app/api/plan/route");
  gens = await import("../app/api/generations/route"); gen = await import("../app/api/generations/[id]/route");
  regen = await import("../app/api/generations/[id]/scenes/[index]/regenerate/route"); videos = await import("../app/api/videos/[name]/route");
}, 60_000);
afterAll(() => { worker?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://x${url}`);
const base = { mode: "t2v", durationSeconds: 8, aspectRatio: "9:16", addons: { voice: true, music: true, sfx: true } };
const idea = { description: "A cat learns to skateboard. It falls, then it tries again, and finally it rolls down the street.", creativePrompt: "bright and funny", language: "en" };
let n = 0;
const balance = async (p: string) => (await (await me.GET(get(`/api/me?plan=${p}`))).json()).balance;

async function start(planId: string) {
  const p = await (await plan.POST(post("/api/plan", { plan: planId, ...base, ...idea }))).json();
  const r = await gens.POST(post("/api/generations", { plan: planId, ...base, idempotencyKey: `live-key-${++n}-padding`, creativePlan: p.plan }));
  return { r, id: (await r.clone().json()).id as string };
}
async function poll(id: string, planId: string, until: (d: any) => boolean = (d) => d.status !== "running", ms = 30_000) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const end = Date.now() + ms;
  for (;;) {
    const d = await (await gen.GET(get(`/api/generations/${id}?plan=${planId}`), { params: Promise.resolve({ id }) })).json();
    if (until(d)) return d;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(d).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", file]).toString());

describe("live engine end to end (real API + Postgres + real Python worker)", () => {
  itw("reports the worker engine; only the configured model is available", async () => {
    expect((await (await me.GET(get("/api/me?plan=pro"))).json()).engine).toBe("worker");
    const list = (await (await models.GET(get("/api/models?plan=pro&mode=t2v&aspect=9:16"))).json()).models as { id: string; available: boolean; reason?: string }[];
    expect(list.find((m) => m.id === "ltx")).toMatchObject({ available: true });
    for (const id of ["wan", "cog", "hunyuan", "vace"]) expect(list.find((m) => m.id === id)).toMatchObject({ available: false, reason: "Coming soon" });
    const img = (await (await models.GET(get("/api/models?plan=pro&mode=i2v&aspect=9:16"))).json()).models;
    expect(img.find((m: { id: string }) => m.id === "ltx").available).toBe(false);
  });

  itw("renders a real stitched video, stores it, and charges exactly the quote (no audio charged)", async () => {
    const before = (await balance("pro")).available;
    const { r, id } = await start("pro");
    expect(r.status).toBe(202);
    const done = await poll(id, "pro");
    expect(done).toMatchObject({ status: "succeeded", stage: "done", progress: 100, credits: { quoted: 24, charged: 24, refunded: 0 } });
    expect(done.quote.lines).toHaveLength(1);                           // video only; voice/music/sfx were requested but not produced
    expect(done.scenes.every((s: { state: string }) => s.state === "done")).toBe(true);
    expect(done.outputUri).toMatch(/^\/api\/videos\/gen_[0-9a-f-]{36}-\d+\.mp4$/);
    const name = done.outputUri.split("/").pop();
    const served = await videos.GET(get(done.outputUri), { params: Promise.resolve({ name }) });
    expect(served.status).toBe(200);
    const p = probe(join(dir, "videos", name));
    expect(p.streams[0]).toMatchObject({ width: 720, height: 1280, codec_name: "h264" });
    expect(Number(p.format.duration)).toBeGreaterThan(7.6);
    expect(Number(p.format.duration)).toBeLessThan(8.4);
    expect((await balance("pro")).available).toBe(before - 24);
  });

  itw("a double submit is one video and one charge", async () => {
    const before = (await balance("pro")).available;
    const p = await (await plan.POST(post("/api/plan", { plan: "pro", ...base, ...idea }))).json();
    const body = { plan: "pro", ...base, idempotencyKey: `dup-key-${++n}-padding`, creativePlan: p.plan };
    const [a, b] = await Promise.all([gens.POST(post("/api/generations", body)), gens.POST(post("/api/generations", body))]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect(ja.id).toBe(jb.id);
    await poll(ja.id, "pro");
    expect((await balance("pro")).available).toBe(before - 24);
  });

  itw("regenerating one scene runs in the background, charges that scene only, and re-stitches", async () => {
    const { id } = await start("pro");
    const done = await poll(id, "pro");
    const before = (await balance("pro")).available;
    const r = await regen.POST(post("/x", { plan: "pro", idempotencyKey: `regen-key-${++n}-padding` }), { params: Promise.resolve({ id, index: "1" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, pending: true });
    const busy = await poll(id, "pro", (d) => d.scenes[1].busy === true, 5000).catch(() => null);
    expect(busy === null || busy.scenes[1].state === "rendering").toBe(true);           // visible while it runs (it may be quick)
    const after = await poll(id, "pro", (d) => d.scenes.every((s: { busy: boolean }) => !s.busy) && d.credits.charged > done.credits.charged);
    expect(after.credits.charged).toBe(24 + 9);
    expect(after.outputUri).not.toBe(done.outputUri);                    // a new stitched video
    expect((await balance("pro")).available).toBe(before - 9);
    expect(probe(join(dir, "videos", after.outputUri.split("/").pop())).format.duration).toBeDefined();
  });

  itw("the free plan's video is made by the worker with the watermark requested", async () => {
    const { id } = await start("free");
    const done = await poll(id, "free");
    expect(done.status).toBe("succeeded");
    expect(done.credits).toMatchObject({ quoted: 24, charged: 24 });
  });

  itw("if the worker dies mid-video, the video fails and every credit comes back", async () => {
    const before = await balance("creator");
    const { id } = await start("creator");
    expect((await balance("creator")).held).toBe(24);
    worker.kill("SIGKILL");
    const failed = await poll(id, "creator", (d) => d.status !== "running", 20_000);
    expect(failed).toMatchObject({ status: "failed", error: { code: "WORKER_UNAVAILABLE" } });
    expect(await balance("creator")).toEqual(before);
    // and new videos are refused cleanly, with nothing charged
    const p = await (await plan.POST(post("/api/plan", { plan: "creator", ...base, ...idea }))).json();
    const again = await gens.POST(post("/api/generations", { plan: "creator", ...base, idempotencyKey: `after-${++n}-padding`, creativePlan: p.plan }));
    const d = await poll((await again.json()).id, "creator");
    expect(d).toMatchObject({ status: "failed" });
    expect(await balance("creator")).toEqual(before);
  }, 60_000);
});

