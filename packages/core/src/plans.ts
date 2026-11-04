import type { Duration, Mode } from "./plan.js";

/**
 * Plans and pricing are DATA. Changing a price, credit grant or limit means
 * changing these rows (later: database rows edited in the admin UI), never the
 * generation workflow.
 */
export interface Plan {
  id: string;
  name: string;
  monthlyCredits: number;
  allowedDurations: readonly Duration[];
  maxConcurrentGenerations: number;
  allowedModes: readonly Mode[];
  watermark: boolean;
}

export const DEFAULT_PLANS: readonly Plan[] = [
  { id: "free", name: "Free", monthlyCredits: 30, allowedDurations: [4, 6, 8], maxConcurrentGenerations: 1, allowedModes: ["t2v", "i2v"], watermark: true },
  { id: "creator", name: "Creator", monthlyCredits: 400, allowedDurations: [4, 6, 8, 12], maxConcurrentGenerations: 3, allowedModes: ["t2v", "i2v", "v2v"], watermark: false },
  { id: "premium", name: "Premium", monthlyCredits: 1500, allowedDurations: [4, 6, 8, 12, 30], maxConcurrentGenerations: 5, allowedModes: ["t2v", "i2v", "v2v"], watermark: false },
];

export interface PricingRule {
  mode: Mode;
  /** Quality tier of the chosen model, e.g. "standard" or "pro". */
  tier: string;
  creditsPerSecond: number;
  /** Fixed credits added once per generation (planning, composing, audio). */
  baseCredits: number;
}

/** Placeholder values: Phase 2 replaces these with measured cost per successful second of video. */
export const DEFAULT_PRICING: readonly PricingRule[] = [
  { mode: "t2v", tier: "standard", creditsPerSecond: 1, baseCredits: 1 },
  { mode: "i2v", tier: "standard", creditsPerSecond: 1, baseCredits: 1 },
  { mode: "v2v", tier: "standard", creditsPerSecond: 2, baseCredits: 2 },
  { mode: "t2v", tier: "pro", creditsPerSecond: 2, baseCredits: 1 },
  { mode: "i2v", tier: "pro", creditsPerSecond: 2, baseCredits: 1 },
  { mode: "v2v", tier: "pro", creditsPerSecond: 3, baseCredits: 2 },
];

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

export function quoteCredits(
  rules: readonly PricingRule[], mode: Mode, tier: string, durationSeconds: number,
): number {
  const rule = rules.find((r) => r.mode === mode && r.tier === tier);
  if (!rule) throw new PricingError(`no pricing rule for ${mode}/${tier}`);
  return rule.baseCredits + Math.ceil(rule.creditsPerSecond * durationSeconds);
}

export function checkPlanAllows(plan: Plan, mode: Mode, duration: number): string[] {
  const issues: string[] = [];
  if (!plan.allowedModes.includes(mode)) issues.push(`plan "${plan.id}" does not include ${mode}`);
  if (!(plan.allowedDurations as readonly number[]).includes(duration)) {
    issues.push(`plan "${plan.id}" does not allow ${duration}s videos`);
  }
  return issues;
}
