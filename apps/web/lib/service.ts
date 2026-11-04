import {
  DEFAULT_PLANS, DEFAULT_PRICING, FakeAdapter, InMemoryGenerationStore, InMemoryLedger, ModelRegistry, applyEvent, isRegionExcluded,
  newJob, type AspectRatio, type CapabilityProfile, type JobView, type Mode, type Plan, type WorkflowDeps,
} from "@clipnova/core";

/**
 * DEMO SERVICE (in-memory, single process). Every model is a FakeAdapter: it simulates rendering time and
 * returns a placeholder URI, so NO real video is produced. Rates and modes mirror the approved prototype;
 * licence fields follow the Phase 0 assessment and need legal review before real use.
 * Real adapters, a database ledger and a durable job queue replace this in later milestones.
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

export interface Service {
  deps: WorkflowDeps;
  registry: ModelRegistry;
  jobs: Map<string, JobView>;
  ratings: Map<string, "up" | "down">;
  seq: number;
}

const g = globalThis as unknown as { __clipnova?: Service };

export function getService(): Service {
  if (g.__clipnova) return g.__clipnova;
  const delayMs = Number(process.env.CLIPNOVA_DEMO_RENDER_MS ?? 1600);
  const registry = new ModelRegistry();
  for (const r of MODELS) registry.register(new FakeAdapter(profile(r), { delayMs }));
  // Prototype's Auto recommendations: text/image -> Wan 2.2, video -> VACE.
  registry.autoOrder = { t2v: ["wan"], i2v: ["wan"], v2v: ["vace"] };
  const store = new InMemoryGenerationStore();
  const svc: Service = {
    seq: 0, registry, jobs: new Map(), ratings: new Map(),
    deps: {
      ledger: new InMemoryLedger(),
      registry, store,
      pricing: DEFAULT_PRICING,
      // NOT ENABLED in the demo: real moderation providers arrive in M1.3.
      moderator: { checkText: async () => [] },
      composer: { compose: async (id) => `demo://${id}/final-${++svc.seq}.mp4` },
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
  // Each demo plan's user receives the plan's monthly credits once.
  await svc.deps.ledger.grant(userId, plan.monthlyCredits, `grant:${userId}`);
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) % 100;
  return { userId, plan, region, bucket: h };
}

export interface ModelAvailability { id: string; name: string; rate: number; modes: Mode[]; available: boolean; reason?: string }

export function modelAvailability(mode: Mode, aspect: AspectRatio, region: string): ModelAvailability[] {
  return getService().registry.list().map(({ adapter, enabled }) => {
    const p = adapter.profile;
    let reason: string | undefined;
    if (!enabled) reason = "Temporarily unavailable";
    else if (!p.modes.includes(mode)) reason = "Not available for this mode";
    else if (!p.aspectRatios.includes(aspect)) reason = "Doesn't support this shape";
    else if (isRegionExcluded(region, p.licence.excludedTerritories ?? [])) reason = "Not available in your region";
    return { id: p.id, name: p.name, rate: p.creditsPerSecond, modes: [...p.modes], available: !reason, reason };
  });
}

export function jsonError(e: unknown) {
  if (e instanceof ApiError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500 });
}
