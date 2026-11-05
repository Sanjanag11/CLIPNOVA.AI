import {
  DEFAULT_PRICING, FakeAdapter, InMemoryGenerationStore, InMemoryLedger, ModelRegistry, RegenError, applyEvent, jobProgress, newJob, regenerateScene, runGeneration,
  type CapabilityProfile, type JobView, type Mode, type WorkflowDeps,
} from "@clipnova/core";
import { ApiError } from "../errors";
import type { Caller, Engine, GenerationView, RegenOutcome, StartInput } from "./types";

/**
 * SIMULATED ENGINE: in memory, single process, fake models that wait a moment and return a placeholder.
 * No video is produced. This is the default when no GPU worker is configured, and what the prototype's flow runs on.
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

const profile = (r: Row): CapabilityProfile => ({
  id: r.id, name: r.name, family: r.id, modes: r.modes, maxClipSeconds: 5, fps: 24,
  aspectRatios: ["9:16", "16:9", "1:1", "4:5"], promptLanguage: "en", creditsPerSecond: r.rate,
  licence: { id: r.licence, commercialUse: true, excludedTerritories: r.excluded },
});

const REGEN_STATUS: Record<string, number> = { NOT_FOUND: 404, BAD_SCENE: 404, NOT_FINISHED: 409, SCENE_BUSY: 409, INSUFFICIENT_CREDITS: 402, NO_MODEL: 409 };

export class SimEngine implements Engine {
  readonly kind = "simulated" as const;
  readonly audio = true; // priced as in the prototype, but only simulated
  readonly ledger = new InMemoryLedger();
  readonly registry = new ModelRegistry();
  readonly pricing = DEFAULT_PRICING;
  private readonly store = new InMemoryGenerationStore();
  private readonly jobs = new Map<string, JobView>();
  private readonly ratings = new Map<string, "up" | "down">();
  private seq = 0;
  private readonly deps: WorkflowDeps;

  constructor(delayMs = Number(process.env.CLIPNOVA_DEMO_RENDER_MS ?? 1600)) {
    for (const r of MODELS) this.registry.register(new FakeAdapter(profile(r), { delayMs }));
    // Prototype's Auto recommendations: text/image -> Wan 2.2, video -> VACE.
    this.registry.autoOrder = { t2v: ["wan"], i2v: ["wan"], v2v: ["vace"] };
    this.deps = {
      ledger: this.ledger, registry: this.registry, store: this.store, pricing: this.pricing,
      // NOT ENABLED yet: real moderation providers arrive in M1.3.
      moderator: { checkText: async () => [] },
      composer: { compose: async (id) => `demo://${id}/final-${++this.seq}.mp4` },
      newId: () => `gen_${++this.seq}`,
      emit: (e) => {
        let job = this.jobs.get(e.generationId);
        if (!job) {
          const gen = this.store.findById(e.generationId);
          if (!gen) return;
          job = newJob(e.generationId, gen.request.creativePlan.scenes.length);
          this.jobs.set(e.generationId, job);
        }
        applyEvent(job, e);
      },
    };
  }

  async start(c: Caller, i: StartInput) {
    const key = `${c.userId}:${i.idempotencyKey}`;
    // Start the job and return immediately; the client polls. runGeneration registers the job before its first await.
    runGeneration(this.deps, {
      userId: c.userId, plan: c.plan, idempotencyKey: key, mode: i.mode, durationSeconds: i.durationSeconds, aspectRatio: i.aspectRatio,
      region: c.region, modelId: i.modelId, addons: i.addons, creativePlan: i.creativePlan, rolloutBucket: c.bucket,
    }).catch((e) => console.error("generation failed", e));
    const gen = this.store.findByIdempotencyKey(key);
    if (!gen) throw new ApiError(500, "Could not start the video.", "INTERNAL");
    return { id: gen.id, status: gen.status };
  }

  async view(c: Caller, id: string): Promise<GenerationView | null> {
    const gen = this.store.findById(id);
    if (!gen || gen.userId !== c.userId) return null;
    const job = this.jobs.get(id);
    const scenes = gen.request.creativePlan.scenes.map((ps) => {
      const live = job?.scenes.find((s) => s.index === ps.index);
      const done = gen.scenes.find((s) => s.index === ps.index);
      const rate = this.registry.get(done?.modelId ?? "")?.profile.creditsPerSecond
        ?? this.registry.select({ mode: gen.request.mode, aspectRatio: gen.request.aspectRatio, region: gen.request.region, modelId: gen.request.modelId })[0]?.profile.creditsPerSecond ?? 0;
      return {
        index: ps.index, durationSeconds: ps.durationSeconds, action: ps.action,
        state: live?.state ?? "queued", progress: live?.progress ?? 0, attempt: live?.attempt ?? 0,
        modelId: live?.modelId ?? done?.modelId, modelName: this.registry.get(live?.modelId ?? done?.modelId ?? "")?.profile.name,
        regenCredits: Math.ceil(rate * ps.durationSeconds), busy: !!done?.busy,
      };
    });
    return {
      id: gen.id, status: gen.status, stage: job?.stage ?? "checking", progress: job ? jobProgress(job) : 0, scenes,
      credits: { quoted: gen.creditsQuoted, charged: gen.creditsCharged, refunded: gen.creditsRefunded },
      quote: gen.quote, modelName: gen.quote?.lines[0]?.label, outputUri: gen.outputUri,
      error: gen.errorCode ? { code: gen.errorCode, reasons: gen.rejectionReasons ?? [] } : undefined,
      rating: this.ratings.get(id), balance: await this.ledger.balance(c.userId),
    };
  }

  async regenerate(c: Caller, id: string, index: number, key: string): Promise<RegenOutcome> {
    const gen = this.store.findById(id);
    if (!gen || gen.userId !== c.userId) throw new ApiError(404, "Video not found.", "NOT_FOUND");
    try {
      const r = await regenerateScene(this.deps, id, index, `${c.userId}:${key}`);
      return { ok: r.ok, creditsCharged: r.creditsCharged, errorCode: r.errorCode };
    } catch (e) {
      if (e instanceof RegenError) throw new ApiError(REGEN_STATUS[e.code] ?? 400, e.message, e.code);
      throw e;
    }
  }

  async rate(c: Caller, id: string, value: "up" | "down") {
    const gen = this.store.findById(id);
    if (!gen || gen.userId !== c.userId) return false;
    this.ratings.set(id, value);
    return true;
  }
}
