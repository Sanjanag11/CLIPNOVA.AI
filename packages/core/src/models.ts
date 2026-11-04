import { isRegionExcluded } from "./regions";
import type { AspectRatio, CreativePlan, Mode, ScenePlan } from "./plan";

/** What a model can do. Validated by contract tests, never assumed. */
export interface CapabilityProfile {
  id: string;
  name: string;
  family: string;
  modes: readonly Mode[];
  maxClipSeconds: number;
  fps: number;
  aspectRatios: readonly AspectRatio[];
  /** Language the model expects its prompt in. */
  promptLanguage: "en";
  /** What users are charged per second of video from this model. */
  creditsPerSecond: number;
  licence: {
    id: string;
    commercialUse: boolean;
    /** ISO country codes or groups (e.g. "EU") where the licence does not grant rights. */
    excludedTerritories?: readonly string[];
    notes?: string;
  };
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

export interface SelectionQuery {
  mode: Mode;
  aspectRatio: AspectRatio;
  /** ISO country code of the user; licence territory exclusions are enforced against it. */
  region: string;
  /** 0-99, stable per user; drives gradual rollouts. */
  bucket?: number;
  /** A specific model the user chose; omit or "auto" for automatic selection. */
  modelId?: string;
  /** Longest scene in the request; models with a shorter max clip are skipped. */
  maxSceneSeconds?: number;
}

export class ModelRegistry {
  private rows = new Map<string, ModelVersionRow>();
  /** Preferred model order for "Auto", per mode (the prototype's recommendations). */
  autoOrder: Partial<Record<Mode, string[]>> = {};

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
   * Eligible models in routing order. Eligible = enabled, in rollout bucket, commercially licensed,
   * licence valid in the user's region, supports mode/aspect ratio/scene length. A user-chosen model
   * is returned alone (never silently swapped); "Auto" returns the preferred order, then cheapest.
   */
  select(q: SelectionQuery): VideoModelAdapter[] {
    const eligible = this.list()
      .filter((r) => r.enabled && (q.bucket ?? 0) < r.rolloutPct)
      .map((r) => r.adapter)
      .filter((a) => {
        const p = a.profile;
        return p.licence.commercialUse
          && !isRegionExcluded(q.region, p.licence.excludedTerritories ?? [])
          && p.modes.includes(q.mode)
          && p.aspectRatios.includes(q.aspectRatio)
          && (q.maxSceneSeconds === undefined || q.maxSceneSeconds <= p.maxClipSeconds);
      });
    if (q.modelId && q.modelId !== "auto") return eligible.filter((a) => a.profile.id === q.modelId);
    const pref = this.autoOrder[q.mode] ?? [];
    const rank = (a: VideoModelAdapter) => { const i = pref.indexOf(a.profile.id); return i === -1 ? Infinity : i; };
    return eligible.sort((a, b) => rank(a) - rank(b)
      || (a.profile.creditsPerSecond - b.profile.creditsPerSecond));
  }
}
