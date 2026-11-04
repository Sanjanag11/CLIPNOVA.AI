import { ModelError, type CapabilityProfile, type SceneRequest, type SceneResult, type VideoModelAdapter } from "../models";

export interface FakeBehavior {
  /** Number of initial attempts per scene that fail before one succeeds. */
  failTimesPerScene?: number;
  /** Scene indexes that always fail. */
  alwaysFailScenes?: number[];
  retryable?: boolean;
  unhealthy?: boolean;
  /** Simulated render time per scene in ms (0 = instant). Demo only. */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic stand-in used by tests and local dev. Real adapters live next to their GPU workers. */
export class FakeAdapter implements VideoModelAdapter {
  readonly calls: SceneRequest[] = [];
  private failures = new Map<number, number>();

  constructor(public readonly profile: CapabilityProfile, private behavior: FakeBehavior = {}) {}

  validate(req: SceneRequest): string[] {
    const issues: string[] = [];
    if (req.scene.durationSeconds > this.profile.maxClipSeconds) {
      issues.push(`scene ${req.scene.index} is ${req.scene.durationSeconds}s; model max is ${this.profile.maxClipSeconds}s`);
    }
    if (!this.profile.modes.includes(req.mode)) issues.push(`mode ${req.mode} unsupported`);
    return issues;
  }

  renderPrompt(req: SceneRequest): string {
    const chars = req.plan.characters.filter((c) => req.scene.characterIds.includes(c.id)).map((c) => `${c.name} (${c.appearance})`);
    return [req.scene.action, chars.join("; "), req.scene.camera, req.plan.setting.visualStyle].filter(Boolean).join(". ");
  }

  async generate(req: SceneRequest, onProgress?: (f: number) => void): Promise<SceneResult> {
    this.calls.push(req);
    const steps = this.behavior.delayMs ? 4 : 1;
    for (let i = 1; i < steps; i++) { await sleep((this.behavior.delayMs ?? 0) / steps); onProgress?.(i / steps); }
    const retryable = this.behavior.retryable ?? true;
    if (this.behavior.alwaysFailScenes?.includes(req.scene.index)) {
      throw new ModelError("scene permanently failed", retryable, "FAKE_ALWAYS_FAIL");
    }
    const used = this.failures.get(req.scene.index) ?? 0;
    if (used < (this.behavior.failTimesPerScene ?? 0)) {
      this.failures.set(req.scene.index, used + 1);
      throw new ModelError("transient GPU failure", retryable, "FAKE_TRANSIENT");
    }
    if (this.behavior.delayMs) await sleep(this.behavior.delayMs / steps);
    onProgress?.(1);
    return {
      outputUri: `fake://${req.generationId}/scene-${req.scene.index}.mp4`,
      durationSeconds: req.scene.durationSeconds,
      seed: req.seed,
      gpuSeconds: req.scene.durationSeconds * 10,
    };
  }

  async healthcheck() {
    return !this.behavior.unhealthy;
  }
}

export const fakeProfile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  id: "fake-standard",
  name: "Fake Standard",
  family: "fake",
  modes: ["t2v", "i2v", "v2v"],
  maxClipSeconds: 5,
  fps: 24,
  aspectRatios: ["9:16", "1:1", "16:9"],
  promptLanguage: "en",
  creditsPerSecond: 4,
  licence: { id: "test", commercialUse: true },
  estCostUsdPerSecond: 0.02,
  ...over,
});
