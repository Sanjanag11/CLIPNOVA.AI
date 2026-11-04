import {
  DEFAULT_PLANS, DEFAULT_PRICING, FakeAdapter, HttpVideoAdapter, InMemoryGenerationStore, InMemoryLedger, ModelRegistry, applyEvent,
  isRegionExcluded, newJob, type AspectRatio, type CapabilityProfile, type Composer, type JobView, type Mode, type Plan, type WorkflowDeps,
} from "@clipnova/core";
import { LIVE_MODES, UI_MODEL_IDS, WORKER_CATALOG } from "./catalog";
import { FfmpegComposer } from "./composer";
import { LocalVideoStore } from "./video-store";

/**
 * DEMO SERVICE (in-memory, single process; no database yet).
 *
 * Two engines:
 *  - "simulated" (default): every model is a FakeAdapter that waits a moment and returns a placeholder; NO real video.
 *  - "worker": set CLIPNOVA_WORKER_URL (+ CLIPNOVA_WORKER_TOKEN) to render with open-source models on an inference
 *    worker (workers/inference). Scenes are stitched by ffmpeg into a real MP4.
 * Rates and modes mirror the approved prototype; licence fields follow the Phase 0 assessment and need legal review.
 */
type Row = { id: string; name: string; modes: Mode[]; rate: number; excluded?: string[]; licence: string };
const MODELS: Row[] = [
  { id: "wan", name: "Wan 2.2", modes: ["t2v", "i2v"], rate: 6, licence: "apache-2.0" },
  { id: "ltx", name: "LTX-Video", modes: ["t2v", "i2v", "v2v"], rate: 3, licence: "ltx-community" },
  { id: "hunyuan", name: "HunyuanVideo 1.5", modes: ["t2v", "i2v"], rate: 7, licence: "tencent-hunyuan-community", excluded: ["EU", "GB", "KR"] },
  { id: "cog", name: "CogVideoX", modes: ["t2v", "i2v", "v2v"], rate: 4, licence: "cogvideox" },
  { id: "vace", name: "VACE", modes: ["t2v", "i2v", "v2v"], rate: 6, licence: "apache-2.0" },
  { id: "svd", name: "Stable Video Diffusion XT", modes: ["i2v"], rate: 3, licence: "stability-community" },
  { id: "longcat", name: "LongCat-Video", modes: ["t2v", "i2v", "v2v"], rate: 7, licence: "mit" },
  { id: "mochi", name: "Mochi 1", modes: ["t2v"], rate: 5, licence: "apache-2.0" },
  { id: "opensora", name: "Open-Sora", modes: ["t2v", "i2v"], rate: 4, licence: "apache-2.0" },
];
const ASPECTS: AspectRatio[] = ["9:16", "16:9", "1:1", "4:5"];

const profile = (r: Row): CapabilityProfile => ({
  id: r.id, name: r.name, family: r.id, modes: r.modes, maxClipSeconds: 5, fps: 24,
  aspectRatios: ASPECTS, promptLanguage: "en", creditsPerSecond: r.rate,
  licence: { id: r.licence, commercialUse: true, excludedTerritories: r.excluded },
});

export type Engine = "simulated" | "worker";

export interface Service {
  engine: Engine;
  deps: WorkflowDeps;
  registry: ModelRegistry;
  jobs: Map<string, JobView>;
  ratings: Map<string, "up" | "down">;
  seq: number;
  workerUrl?: string;
  workerToken?: string;
  discoveredAt: number;
}

const g = globalThis as unknown as { __clipnova?: Service };

function buildRegistry(engine: Engine, workerUrl: string | undefined, workerToken: string | undefined, store: LocalVideoStore | undefined): ModelRegistry {
  const registry = new ModelRegistry();
  if (engine === "worker") {
    const wanted = (process.env.CLIPNOVA_WORKER_MODELS ?? WORKER_CATALOG.map((m) => m.id).join(",")).split(",").map((x) => x.trim());
    for (const m of WORKER_CATALOG.filter((c) => wanted.includes(c.id))) {
      const prof: CapabilityProfile = {
        id: m.id, name: m.name, family: m.id, modes: LIVE_MODES, maxClipSeconds: m.maxClipSeconds, fps: m.fps, aspectRatios: m.aspects,
        promptLanguage: "en", creditsPerSecond: m.creditsPerSecond,
        licence: { id: m.licenceId, commercialUse: true, notes: m.licenceNote },
      };
      registry.register(new HttpVideoAdapter(prof, {
        baseUrl: workerUrl!, token: workerToken, workerModelId: m.workerId, store: store!,
        timeoutMs: Number(process.env.CLIPNOVA_SCENE_TIMEOUT_MS ?? 20 * 60_000),
        pollMs: Number(process.env.CLIPNOVA_POLL_MS ?? 1500),
      }));
    }
    registry.autoOrder = { t2v: ["wan", "ltx", "cog"] };
  } else {
    const delayMs = Number(process.env.CLIPNOVA_DEMO_RENDER_MS ?? 1600);
    for (const r of MODELS) registry.register(new FakeAdapter(profile(r), { delayMs }));
    // Prototype's Auto recommendations: text/image -> Wan 2.2, video -> VACE.
    registry.autoOrder = { t2v: ["wan"], i2v: ["wan"], v2v: ["vace"] };
  }
  return registry;
}

export function getService(): Service {
  if (g.__clipnova) return g.__clipnova;
  const workerUrl = process.env.CLIPNOVA_WORKER_URL?.trim() || undefined;
  const engine: Engine = workerUrl ? "worker" : "simulated";
  const workerToken = process.env.CLIPNOVA_WORKER_TOKEN || undefined;
  const videoStore = engine === "worker" ? new LocalVideoStore() : undefined;
  const registry = buildRegistry(engine, workerUrl, workerToken, videoStore);
  const store = new InMemoryGenerationStore();
  const composer: Composer = engine === "worker"
    ? new FfmpegComposer()
    : { compose: async (id) => `demo://${id}/final-${++svc.seq}.mp4` };
  const svc: Service = {
    engine, workerUrl, workerToken, discoveredAt: 0,
    seq: 0, registry, jobs: new Map(), ratings: new Map(),
    deps: {
      ledger: new InMemoryLedger(),
      registry, store,
      pricing: DEFAULT_PRICING,
      // NOT ENABLED yet: real moderation providers arrive in M1.3.
      moderator: { checkText: async () => [] },
      composer,
      newId: () => `gen_${++svc.seq}`,
      emit: (e) => {
        let job = svc.jobs.get(e.generationId);
        if (!job) {
          const gen = store.findById(e.generationId);
          if (!gen) return;
          job = newJob(e.generationId, gen.request.creativePlan.scenes.length);
          svc.jobs.set(e.generationId, job);
        }
        applyEvent(job, e);
      },
    },
  };
  g.__clipnova = svc;
  return svc;
}

/**
 * Asks the worker which models it really serves and turns off the ones it doesn't, so the app never
 * assumes a capability the worker lacks. Cached for a minute; if the worker is unreachable nothing changes
 * (jobs then fail and are refunded).
 */
export async function refreshWorker(svc: Service = getService()): Promise<void> {
  if (svc.engine !== "worker" || Date.now() - svc.discoveredAt < 60_000) return;
  svc.discoveredAt = Date.now();
  try {
    const res = await fetch(`${svc.workerUrl!.replace(/\/+$/, "")}/v1/models`, {
      headers: svc.workerToken ? { authorization: `Bearer ${svc.workerToken}` } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const served = new Set(((await res.json()) as { models: { id: string }[] }).models.map((m) => m.id));
    for (const m of WORKER_CATALOG) if (svc.registry.get(m.id)) svc.registry.setEnabled(m.id, served.has(m.workerId));
  } catch {
    svc.discoveredAt = 0; // try again on the next request
  }
}

/**
 * Voiceover, music and sound effects are only simulated today. The live engine produces no audio, so it must
 * not charge for it: add-ons are switched off there until audio generation exists.
 */
export function effectiveAddons(svc: Service, requested: { voice: boolean; music: boolean; sfx: boolean }) {
  return svc.engine === "worker" ? { voice: false, music: false, sfx: false } : requested;
}

/** The demo has no sign-in yet, so the caller picks a demo plan. Disabled in production unless explicitly enabled. */
export function demoEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.CLIPNOVA_DEMO === "1";
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

export interface Caller { userId: string; plan: Plan; region: string; bucket: number }

export async function identify(req: Request, planId: string | undefined, regionOverride?: string): Promise<Caller> {
  if (!demoEnabled()) throw new ApiError(501, "Sign-in is not available yet.", "AUTH_NOT_CONFIGURED");
  const plan = DEFAULT_PLANS.find((p) => p.id === (planId ?? "free"));
  if (!plan) throw new ApiError(400, "Unknown plan.", "BAD_PLAN");
  const header = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry");
  const region = (regionOverride || header || "IN").toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new ApiError(400, "Region must be a 2-letter country code.", "BAD_REGION");
  const userId = `demo-${plan.id}`;
  const svc = getService();
  await refreshWorker(svc);
  // Each demo plan's user receives the plan's monthly credits once.
  await svc.deps.ledger.grant(userId, plan.monthlyCredits, `grant:${userId}`);
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) % 100;
  return { userId, plan, region, bucket: h };
}

export interface ModelAvailability { id: string; name: string; rate: number; modes: Mode[]; available: boolean; reason?: string }

export function modelAvailability(mode: Mode, aspect: AspectRatio, region: string): ModelAvailability[] {
  const rows = new Map(getService().registry.list().map((r) => [r.adapter.profile.id, r]));
  return UI_MODEL_IDS.map((u) => {
    const row = rows.get(u.id);
    if (!row) return { id: u.id, name: u.name, rate: u.rate, modes: u.modes, available: false, reason: "Coming soon" };
    const p = row.adapter.profile;
    let reason: string | undefined;
    if (!row.enabled) reason = "Temporarily unavailable";
    else if (!p.modes.includes(mode)) reason = mode === "t2v" ? "Not available for this mode" : "Not available yet for this mode";
    else if (!p.aspectRatios.includes(aspect)) reason = "Doesn't support this shape";
    else if (isRegionExcluded(region, p.licence.excludedTerritories ?? [])) reason = "Not available in your region";
    return { id: p.id, name: p.name, rate: p.creditsPerSecond, modes: u.modes, available: !reason, reason };
  });
}

export function jsonError(e: unknown) {
  if (e instanceof ApiError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500 });
}
