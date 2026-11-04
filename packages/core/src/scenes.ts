/**
 * Splits a requested total duration into per-scene clip lengths.
 * Most open video models top out near 5 s per clip, so longer videos are
 * assembled from several scenes. Clips are kept as even as possible.
 */
export function splitDuration(totalSeconds: number, maxClipSeconds: number): number[] {
  if (!(totalSeconds > 0)) throw new RangeError("totalSeconds must be positive");
  if (!(maxClipSeconds > 0)) throw new RangeError("maxClipSeconds must be positive");
  const n = Math.ceil(totalSeconds / maxClipSeconds);
  const base = Math.floor(totalSeconds / n);
  const remainder = totalSeconds - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Largest-remainder allocation so per-scene credits always sum exactly to `total`. */
export function allocateCredits(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new RangeError("weights must sum to a positive number");
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return floors;
}
