import type { Addons, AspectRatio, CreativePlan, Ledger, Mode, ModelRegistry, Plan, PricingConfig, Quote } from "@clipnova/core";

export interface Caller {
  userId: string; plan: Plan; region: string; bucket: number;
  /** Anonymous tester id (set by proxy.ts); absent in local tests. */
  uid?: string;
  /** This tester's A/B variants, by experiment id. */
  variants: Record<string, string>;
}

export interface StartInput {
  idempotencyKey: string;
  mode: Mode;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  modelId?: string;
  addons: Addons;
  creativePlan: CreativePlan;
}

export interface SceneView {
  index: number; durationSeconds: number; action: string;
  state: "queued" | "rendering" | "retrying" | "done" | "failed";
  progress: number; attempt: number; modelId?: string; modelName?: string; regenCredits: number; busy: boolean;
}

/** What GET /api/generations/:id returns; the Create screen reads exactly this. */
export interface GenerationView {
  id: string; status: string; stage: string; progress: number; scenes: SceneView[];
  credits: { quoted: number; charged: number; refunded: number };
  quote?: Quote; modelName?: string; outputUri?: string;
  error?: { code: string; reasons: string[] }; rating?: "up" | "down";
  balance: { available: number; held: number; spent: number };
}

export interface RegenOutcome { ok: boolean; creditsCharged: number; errorCode?: string; pending?: boolean }

/** How a generation is run. "simulated" = in memory with fake models; "worker" = Postgres + a remote GPU worker. */
export interface Engine {
  kind: "simulated" | "worker";
  ledger: Ledger;
  registry: ModelRegistry;
  pricing: PricingConfig;
  /** True when voiceover/music/sfx are really produced (and may therefore be charged). */
  audio: boolean;
  start(c: Caller, i: StartInput): Promise<{ id: string; status: string }>;
  view(c: Caller, id: string): Promise<GenerationView | null>;
  /** Throws ApiError for client errors (not found, busy, not enough credits). */
  regenerate(c: Caller, id: string, index: number, key: string): Promise<RegenOutcome>;
  rate(c: Caller, id: string, value: "up" | "down"): Promise<boolean>;
  /** Called before requests so the engine can notice what its backend really supports. */
  refresh?(): Promise<void>;
}
