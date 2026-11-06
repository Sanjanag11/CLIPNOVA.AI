import type { AspectRatio, Mode } from "@clipnova/core";

/**
 * Business metadata for the open-source models the inference worker can serve.
 * Technical capability (what a model can actually render) is decided by the worker; this table decides
 * price, licence handling and which modes the product exposes today.
 */
export interface CatalogEntry {
  /** App-level id, matches the model ids in the prototype UI. */
  id: string;
  name: string;
  /** Id on the worker (workers/inference). */
  workerId: string;
  creditsPerSecond: number;
  licenceId: string;
  licenceNote?: string;
  aspects: AspectRatio[];
  maxClipSeconds: number;
  fps: number;
}

/** Image/video input needs stored uploads, which don't exist yet, so only text-to-video is exposed. */
export const LIVE_MODES: Mode[] = ["t2v"];
const ALL_ASPECTS: AspectRatio[] = ["9:16", "16:9", "1:1", "4:5"];

export const WORKER_CATALOG: CatalogEntry[] = [
  { id: "wan", name: "Wan 2.2", workerId: "wan22-ti2v-5b", creditsPerSecond: 6, licenceId: "apache-2.0", aspects: ALL_ASPECTS, maxClipSeconds: 5, fps: 24 },
  { id: "ltx", name: "LTX-Video", workerId: "ltx-video", creditsPerSecond: 3, licenceId: "ltxv-open-weights-0.x", licenceNote: "free below $10M annual revenue; users must be bound by the use restrictions and AI-generated content disclosed (docs/open-source-stack.md)", aspects: ALL_ASPECTS, maxClipSeconds: 5, fps: 24 },
  { id: "cog", name: "CogVideoX", workerId: "cogvideox-2b", creditsPerSecond: 4, licenceId: "apache-2.0", aspects: ["16:9"], maxClipSeconds: 6, fps: 8 },
];

/** Every model id the UI lists. Ones without a live worker are shown as "Coming soon". */
export const UI_MODEL_IDS: { id: string; name: string; rate: number; modes: Mode[] }[] = [
  { id: "wan", name: "Wan 2.2", rate: 6, modes: ["t2v", "i2v"] },
  { id: "ltx", name: "LTX-Video", rate: 3, modes: ["t2v", "i2v", "v2v"] },
  { id: "hunyuan", name: "HunyuanVideo 1.5", rate: 7, modes: ["t2v", "i2v"] },
  { id: "cog", name: "CogVideoX", rate: 4, modes: ["t2v", "i2v", "v2v"] },
  { id: "vace", name: "VACE", rate: 6, modes: ["t2v", "i2v", "v2v"] },
  { id: "svd", name: "Stable Video Diffusion XT", rate: 3, modes: ["i2v"] },
  { id: "longcat", name: "LongCat-Video", rate: 7, modes: ["t2v", "i2v", "v2v"] },
  { id: "mochi", name: "Mochi 1", rate: 5, modes: ["t2v"] },
  { id: "opensora", name: "Open-Sora", rate: 4, modes: ["t2v", "i2v"] },
];
