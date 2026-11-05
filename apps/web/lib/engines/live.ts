import { randomUUID } from "node:crypto";
import {
  DEFAULT_PRICING, ModelRegistry, type CapabilityProfile, type SceneRequest, type SceneResult, type VideoModelAdapter,
} from "@clipnova/core";
import { LIVE_MODES, WORKER_CATALOG } from "../catalog";
import { getDb, type Db } from "../db";
import { SqlLedger } from "../db/sql-ledger";
import { getFileStore, type FileStore } from "../files";
import { LiveEngine } from "../live/engine";
import { GenerationRepo } from "../live/repo";
import { WorkerClient } from "../live/worker";

/** A model that lives on the worker: the app only needs its profile (price, licence, shapes) to select and quote it. */
class RemoteModel implements VideoModelAdapter {
  constructor(readonly profile: CapabilityProfile) {}
  validate(_req: SceneRequest): string[] { return []; }
  renderPrompt(): string { return ""; }
  generate(): Promise<SceneResult> { throw new Error("remote models are rendered by the worker, not in-process"); }
  async healthcheck() { return true; }
}

export interface LiveConfig {
  workerUrl: string;
  workerToken?: string;
  /** App-level model ids to offer, in Auto order. */
  models?: string[];
  db?: Db;
  files?: FileStore;
  fetch?: typeof fetch;
  jobTimeoutMs?: number;
  workerLossMs?: number;
  now?: () => number;
}

export async function buildLiveEngine(cfg: LiveConfig): Promise<LiveEngine> {
  const db = cfg.db ?? (await getDb());
  const wanted = cfg.models ?? WORKER_CATALOG.map((m) => m.id);
  const registry = new ModelRegistry();
  const workerIds: Record<string, string> = {};
  for (const m of WORKER_CATALOG.filter((c) => wanted.includes(c.id))) {
    registry.register(new RemoteModel({
      id: m.id, name: m.name, family: m.id, modes: LIVE_MODES, maxClipSeconds: m.maxClipSeconds, fps: m.fps, aspectRatios: m.aspects,
      promptLanguage: "en", creditsPerSecond: m.creditsPerSecond,
      licence: { id: m.licenceId, commercialUse: true, notes: m.licenceNote },
    }));
    workerIds[m.id] = m.workerId;
  }
  registry.autoOrder = { t2v: wanted.filter((id) => workerIds[id]) };
  return new LiveEngine({
    repo: new GenerationRepo(db), ledger: new SqlLedger(db), registry, pricing: DEFAULT_PRICING,
    worker: new WorkerClient({ baseUrl: cfg.workerUrl, token: cfg.workerToken, fetch: cfg.fetch }),
    files: cfg.files ?? getFileStore(), workerIds,
    // NOT ENABLED yet: real moderation providers arrive in M1.3.
    moderator: { checkText: async () => [] },
    newId: () => `gen_${randomUUID()}`, jobTimeoutMs: cfg.jobTimeoutMs, workerLossMs: cfg.workerLossMs, now: cfg.now,
  });
}

export function liveConfigFromEnv(): LiveConfig | undefined {
  const workerUrl = process.env.CLIPNOVA_WORKER_URL?.trim();
  if (!workerUrl) return undefined;
  return {
    workerUrl, workerToken: process.env.CLIPNOVA_WORKER_TOKEN || undefined,
    models: process.env.CLIPNOVA_WORKER_MODELS?.split(",").map((x) => x.trim()).filter(Boolean),
    jobTimeoutMs: process.env.CLIPNOVA_JOB_TIMEOUT_MS ? Number(process.env.CLIPNOVA_JOB_TIMEOUT_MS) : undefined,
    workerLossMs: process.env.CLIPNOVA_WORKER_LOSS_MS ? Number(process.env.CLIPNOVA_WORKER_LOSS_MS) : undefined,
  };
}
