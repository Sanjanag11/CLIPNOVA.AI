import type { Duration, Mode } from "./plan.js";

/**
 * Plans and pricing are DATA. Changing a price, credit grant or limit means
 * changing these rows (later: database rows edited in the admin UI), never the
 * generation workflow. Values mirror the approved prototype (Plans & credits screen).
 */
export interface Plan {
  id: string;
  name: string;
  monthlyCredits: number;
  allowedDurations: readonly Duration[];
  maxConcurrentGenerations: number;
  allowedModes: readonly Mode[];
  watermark: boolean;
  maxResolution: "720p" | "1080p";
}

export const DEFAULT_PLANS: readonly Plan[] = [
  { id: "free", name: "Free", monthlyCredits: 120, allowedDurations: [4, 6, 8, 12], maxConcurrentGenerations: 1, allowedModes: ["t2v", "i2v", "v2v"], watermark: true, maxResolution: "720p" },
  { id: "creator", name: "Creator", monthlyCredits: 900, allowedDurations: [4, 6, 8, 12, 30], maxConcurrentGenerations: 3, allowedModes: ["t2v", "i2v", "v2v"], watermark: false, maxResolution: "1080p" },
  { id: "pro", name: "Pro", monthlyCredits: 2500, allowedDurations: [4, 6, 8, 12, 30], maxConcurrentGenerations: 5, allowedModes: ["t2v", "i2v", "v2v"], watermark: false, maxResolution: "1080p" },
];

export interface Addons {
  voice: boolean;
  music: boolean;
  sfx: boolean;
}

export interface PricingConfig {
  /** One voiceover credit per this many seconds of video (rounded up). */
  voiceSecondsPerCredit: number;
  musicCredits: number;
  sfxCredits: number;
}

/** Mirrors the prototype: voiceover 1 per 4 s, music 2, sound effects 1, captions free. */
export const DEFAULT_PRICING: PricingConfig = { voiceSecondsPerCredit: 4, musicCredits: 2, sfxCredits: 1 };

export interface QuoteLine { label: string; credits: number }
export interface Quote { lines: QuoteLine[]; total: number }

/** Video credits come from the model's own rate (`creditsPerSecond` in its capability profile). */
export function quoteCredits(
  cfg: PricingConfig, modelName: string, creditsPerSecond: number, durationSeconds: number, addons: Addons,
): Quote {
  const lines: QuoteLine[] = [
    { label: `Video · ${modelName} · ${durationSeconds}s`, credits: Math.ceil(creditsPerSecond * durationSeconds) },
  ];
  if (addons.voice) lines.push({ label: "Voiceover", credits: Math.ceil(durationSeconds / cfg.voiceSecondsPerCredit) });
  if (addons.music) lines.push({ label: "Music", credits: cfg.musicCredits });
  if (addons.sfx) lines.push({ label: "Sound effects", credits: cfg.sfxCredits });
  return { lines, total: lines.reduce((a, l) => a + l.credits, 0) };
}

export function checkPlanAllows(plan: Plan, mode: Mode, duration: number): string[] {
  const issues: string[] = [];
  if (!plan.allowedModes.includes(mode)) issues.push(`plan "${plan.id}" does not include ${mode}`);
  if (!(plan.allowedDurations as readonly number[]).includes(duration)) {
    issues.push(`plan "${plan.id}" does not allow ${duration}s videos`);
  }
  return issues;
}
