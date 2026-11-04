import {
  DEFAULT_PLANS, DEFAULT_PRICING, FakeAdapter, InMemoryGenerationStore, InMemoryLedger, ModelRegistry,
  splitDuration, type AspectRatio, type CapabilityProfile, type CreativePlan, type Mode, type WorkflowDeps,
} from "@clipnova/core";

/**
 * DEMO SERVICE. Every model below is a FakeAdapter: it simulates success and returns a placeholder URI.
 * No video is generated. Rates and modes mirror the approved prototype; licence fields follow the
 * Phase 0 assessment and need legal review before real use. Real adapters replace these in M1.2.
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

interface Service { deps: WorkflowDeps; registry: ModelRegistry; seq: number }

const g = globalThis as unknown as { __clipnova?: Service };

export function getService(): Service {
  if (g.__clipnova) return g.__clipnova;
  const registry = new ModelRegistry();
  for (const r of MODELS) registry.register(new FakeAdapter(profile(r)));
  // Prototype's Auto recommendations: text/image -> Wan 2.2, video -> VACE.
  registry.autoOrder = { t2v: ["wan"], i2v: ["wan"], v2v: ["vace"] };
  const svc: Service = {
    seq: 0,
    registry,
    deps: {
      ledger: new InMemoryLedger(),
      registry,
      store: new InMemoryGenerationStore(),
      pricing: DEFAULT_PRICING,
      // Placeholder moderation: real moderation providers arrive in M1.3.
      moderator: { checkText: async () => [] },
      composer: { compose: async (id) => `demo://${id}/final.mp4` },
      newId: () => `gen_${++svc.seq}`,
    },
  };
  g.__clipnova = svc;
  return svc;
}

export const MODEL_CHOICES = MODELS.map((m) => ({ id: m.id, name: m.name, modes: m.modes, rate: m.rate }));

/** PLACEHOLDER planner: splits the idea evenly across scenes. Replaced by the Claude Creative Plan planner. */
export function placeholderPlan(input: { description: string; prompt: string; durationSeconds: number; language: string }): CreativePlan {
  const lengths = splitDuration(input.durationSeconds, 5);
  return {
    schemaVersion: 1,
    rawInput: { description: input.description, creativePrompt: input.prompt },
    inputLanguage: input.language,
    intent: { logline: input.description.slice(0, 120) },
    characters: [],
    setting: {},
    scenes: lengths.map((d, i) => ({ index: i, durationSeconds: d, action: `Part ${i + 1} of ${lengths.length}: ${input.description}`, characterIds: [], sfx: [], sourcePhrases: [] })),
    audio: { narrationLanguage: "en", captionLanguage: "en" },
    safety: { flags: [] },
  };
}

export function regionFrom(req: Request, override?: string): string {
  const h = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry");
  return (override || h || "IN").toUpperCase();
}

export type { AspectRatio };
export { DEFAULT_PLANS };
