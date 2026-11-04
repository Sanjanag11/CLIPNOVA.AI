import type { AspectRatio, CreativePlan, Mode, ScenePlan } from "./plan.js";

/** What a model can do. Validated by contract tests, never assumed. */
export interface CapabilityProfile {
  id: string;
  family: string;
  modes: readonly Mode[];
  maxClipSeconds: number;
  fps: number;
  aspectRatios: readonly AspectRatio[];
  /** Language the model expects its prompt in. */
  promptLanguage: "en";
  tier: string;
  licence: { id: string; commercialUse: boolean; notes?: string };
  /** Vendor-stated or estimated until measured in Phase 2. */
  estCostUsdPerSecond?: number;
}

export interface SceneRequest {
  generationId: string;
  scene: ScenePlan;
  plan: CreativePlan;
  mode: Mode;
  aspectRatio: AspectRatio;
  /** Input asset ids (uploaded image/video, or previous scene's last frame). */
  inputAssetIds: string[];
  seed: number;
  attempt: number;
}

export interface SceneResult {
  outputUri: string;
  durationSeconds: number;
  seed: number;
  gpuSeconds: number;
}

export class ModelError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly code: string) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * The only thing the orchestrator knows about a video model. One adapter per
 * model family. No model-specific logic is allowed outside adapters.
 */
export interface VideoModelAdapter {
  readonly profile: CapabilityProfile;
  validate(req: SceneRequest): string[];
  /** Renders the model-agnostic scene into this model's prompt format. */
  renderPrompt(req: SceneRequest): string;
  generate(req: SceneRequest, onProgress?: (fraction: number) => void): Promise<SceneResult>;
  healthcheck(): Promise<boolean>;
}

export interface ModelVersionRow {
  adapter: VideoModelAdapter;
  enabled: boolean;
  /** 0-100: percentage of eligible traffic routed here (gradual rollout). */
  rolloutPct: number;
}

export class ModelRegistry {
  private rows = new Map<string, ModelVersionRow>();

  register(adapter: VideoModelAdapter, opts: { enabled?: boolean; rolloutPct?: number } = {}): void {
    this.rows.set(adapter.profile.id, { adapter, enabled: opts.enabled ?? true, rolloutPct: opts.rolloutPct ?? 100 });
  }
  setEnabled(id: string, enabled: boolean): void {
    const r = this.rows.get(id);
    if (!r) throw new Error(`unknown model ${id}`);
    r.enabled = enabled;
  }
  get(id: string): VideoModelAdapter | undefined {
    return this.rows.get(id)?.adapter;
  }
  list(): ModelVersionRow[] {
    return [...this.rows.values()];
  }

  /**
   * Rule-based selection: enabled, commercially licensed, supports the mode and
   * aspect ratio, matches tier; cheapest first. `bucket` (0-99) makes rollout
   * percentages deterministic per user.
   */
  candidates(mode: Mode, aspect: AspectRatio, tier: string, bucket = 0): VideoModelAdapter[] {
    return this.list()
      .filter((r) => r.enabled && bucket < r.rolloutPct)
      .map((r) => r.adapter)
      .filter((a) => a.profile.licence.commercialUse && a.profile.modes.includes(mode)
        && a.profile.aspectRatios.includes(aspect) && a.profile.tier === tier)
      .sort((a, b) => (a.profile.estCostUsdPerSecond ?? Infinity) - (b.profile.estCostUsdPerSecond ?? Infinity));
  }
}
