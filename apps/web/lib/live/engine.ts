import {
  CreativePlanSchema, InsufficientCreditsError, allocateCredits, buildPrompt, quoteCredits, validateGenerationRequest,
  type Ledger, type ModelRegistry, type PricingConfig, type SceneRequest,
} from "@clipnova/core";
import { ApiError } from "../errors";
import type { FileStore } from "../files";
import type { Caller, Engine, GenerationView, RegenOutcome, StartInput } from "../engines/types";
import { GenerationRepo, type GenRow, type LiveData, type LiveScene, type RegenRecord } from "./repo";
import { WorkerHttpError, WorkerUnreachable, type WorkerClient, type WorkerVideo } from "./worker";

export interface LiveEngineDeps {
  repo: GenerationRepo;
  ledger: Ledger;
  registry: ModelRegistry;
  pricing: PricingConfig;
  worker: WorkerClient;
  files: FileStore;
  /** App-level model id -> id on the worker. */
  workerIds: Record<string, string>;
  moderator: { checkText(text: string): Promise<string[]> };
  newId: () => string;
  now?: () => number;
  /** A job older than this is failed and refunded. */
  jobTimeoutMs?: number;
  /** The worker has been unreachable for this long: fail and refund. */
  workerLossMs?: number;
}

const prettyReasons = (m: string | undefined) => (m ? [m] : []);

/**
 * Runs generations on a remote GPU worker and keeps ALL state in the database, so it works on short-lived
 * serverless functions: starting a video only reserves credits and hands the job to the worker; every status
 * request asks the worker how it is going and, when it has finished, stores the video and settles the credits.
 */
export class LiveEngine implements Engine {
  readonly kind = "worker" as const;
  readonly audio = false;
  constructor(private readonly d: LiveEngineDeps) {}

  get ledger() { return this.d.ledger; }
  get registry() { return this.d.registry; }
  get pricing() { return this.d.pricing; }
  private now() { return (this.d.now ?? Date.now)(); }

  private discoveredAt = 0;
  /**
   * Asks the worker which models it really serves and switches off the ones it doesn't, so the app never assumes a
   * capability the worker lacks. Cached for a minute; if the worker is unreachable nothing changes
   * (videos then fail and are refunded).
   */
  async refresh(): Promise<void> {
    if (this.now() - this.discoveredAt < 60_000) return;
    this.discoveredAt = this.now();
    try {
      const served = new Set((await this.d.worker.models()).map((m) => m.id));
      for (const [appId, workerId] of Object.entries(this.d.workerIds)) if (this.d.registry.get(appId)) this.d.registry.setEnabled(appId, served.has(workerId));
    } catch {
      this.discoveredAt = 0; // try again on the next request
    }
  }

  // ---------------------------------------------------------------------------------------------------- start
  async start(c: Caller, i: StartInput): Promise<{ id: string; status: string }> {
    const plan = CreativePlanSchema.parse(i.creativePlan);
    const key = `${c.userId}:${i.idempotencyKey}`;
    const id = this.d.newId();
    const now = this.now();
    const data: LiveData = {
      userId: c.userId,
      request: { mode: i.mode, durationSeconds: i.durationSeconds, aspectRatio: i.aspectRatio, modelId: i.modelId, region: c.region, planId: c.plan.id, watermark: c.plan.watermark, creativePlan: plan },
      creditsQuoted: 0, creditsCharged: 0, creditsRefunded: 0, stage: "checking", progress: 0, startedAt: now, lastWorkerOkAt: now, regens: {},
      scenes: plan.scenes.map((s) => ({ index: s.index, durationSeconds: s.durationSeconds, action: s.action, state: "queued", progress: 0, attempt: 0, revision: 0, credits: 0 })),
    };
    // Registered first, so a double click or client retry finds this job instead of starting a second one.
    const { row, created } = await this.d.repo.insertNew(id, c.userId, key, "running", data);
    if (!created) return { id: row.id, status: row.status };

    const reject = async (code: string, reasons: string[], status = "rejected") => {
      data.error = { code, reasons }; data.stage = "done"; data.progress = 1;
      await this.d.repo.save(id, status, data);
      return { id, status };
    };

    const issues = validateGenerationRequest({ creativePlan: plan, plan: c.plan, mode: i.mode as never, durationSeconds: i.durationSeconds });
    if (issues.length) return reject("INVALID_REQUEST", issues);
    if ((await this.d.repo.countRunning(c.userId)) > c.plan.maxConcurrentGenerations) {
      return reject("CONCURRENCY_LIMIT", [`concurrency limit ${c.plan.maxConcurrentGenerations} reached`]);
    }
    const blocked = await this.d.moderator.checkText([plan.rawInput.description, plan.rawInput.creativePrompt, ...plan.scenes.map((s) => s.action)].join("\n"));
    if (blocked.length) return reject("MODERATION_BLOCKED", blocked);

    const eligible = this.d.registry.select({
      mode: i.mode, aspectRatio: i.aspectRatio, region: c.region, bucket: c.bucket, modelId: i.modelId,
      maxSceneSeconds: Math.max(...plan.scenes.map((s) => s.durationSeconds)),
    });
    const primary = eligible[0]?.profile;
    if (!primary) return reject("NO_MODEL", ["no eligible model for this request, mode and region"]);
    data.model = { id: primary.id, name: primary.name, workerId: this.d.workerIds[primary.id] ?? primary.id, rate: primary.creditsPerSecond };

    data.quote = quoteCredits(this.d.pricing, primary.name, primary.creditsPerSecond, i.durationSeconds, { voice: false, music: false, sfx: false });
    data.creditsQuoted = data.quote.total;
    const alloc = allocateCredits(data.creditsQuoted, plan.scenes.map((s) => s.durationSeconds));
    data.scenes.forEach((s, n) => (s.credits = alloc[n] ?? 0));
    try {
      await this.d.ledger.reserve(c.userId, id, data.creditsQuoted, `reserve:${key}`);
    } catch (e) {
      if (e instanceof InsufficientCreditsError) return reject("INSUFFICIENT_CREDITS", [e.message]);
      throw e;
    }

    try {
      data.workerVideoId = await this.d.worker.createVideo({
        model: data.model.workerId, aspectRatio: i.aspectRatio, watermark: c.plan.watermark, seed: Number(`${Date.now()}`.slice(-9)),
        scenes: plan.scenes.map((s) => ({ prompt: buildPrompt(this.sceneReq(id, plan, s.index, i.mode, i.aspectRatio, s.action)), seconds: s.durationSeconds })),
      });
    } catch (e) {
      await this.releaseAll(id, data);
      const rejected = e instanceof WorkerHttpError && e.status < 500 && e.status !== 429;
      return reject(rejected ? "WORKER_REJECTED" : "WORKER_UNAVAILABLE", [rejected ? "The video model could not take this request." : "The video service is busy or offline. You were not charged."], "failed");
    }
    data.stage = "rendering";
    await this.d.repo.save(id, "running", data);
    return { id, status: "running" };
  }

  private sceneReq(generationId: string, plan: ReturnType<typeof CreativePlanSchema.parse>, index: number, mode: string, aspect: string, action: string): SceneRequest {
    const scene = { ...plan.scenes[index]!, action };
    return { generationId, scene, plan, mode: mode as never, aspectRatio: aspect as never, inputAssetIds: [], seed: 0, attempt: 1 };
  }

  private async releaseAll(id: string, data: LiveData) {
    const held = await this.d.ledger.heldFor(id);
    if (held > 0) {
      await this.d.ledger.release(id, held, `release-all:${id}`);
      data.creditsRefunded += held;
    }
  }

  // ---------------------------------------------------------------------------------------------------- view
  async view(c: Caller, id: string): Promise<GenerationView | null> {
    let row = await this.d.repo.load(id);
    if (!row || row.userId !== c.userId) return null;
    if (this.needsRefresh(row)) {
      const leased = await this.d.repo.lease(id, this.now());
      if (leased) {
        try {
          await this.refreshOne(leased);
        } catch (e) {
          await this.d.repo.save(id, leased.status, leased.data).catch(() => undefined); // release the lease even on error
          throw e;
        }
        row = (await this.d.repo.load(id)) ?? row;
      }
    }
    return this.toView(row, c);
  }

  private needsRefresh(row: GenRow) {
    return row.status === "running" || Object.values(row.data.regens).some((r) => r.status === "running");
  }

  /** Asks the worker how things are going and applies the outcome. Runs under the lease; always saves. */
  private async refreshOne(row: GenRow): Promise<void> {
    const { id, data } = row;
    let status = row.status;
    const now = this.now();

    // 1. the main video
    if (status === "running") {
      const finish = async (code: string, message: string) => {
        await this.releaseAll(id, data);
        data.error = { code, reasons: [message] }; data.stage = "done"; data.progress = 1; status = "failed";
      };
      if (!data.workerVideoId) {
        // The request died between reserving credits and starting the job (e.g. the function was stopped).
        if (now - data.startedAt > 2 * 60_000) await finish("WORKER_UNAVAILABLE", "The video could not be started. You were not charged.");
      } else if (now - data.startedAt > (this.d.jobTimeoutMs ?? 25 * 60_000)) {
        await finish("WORKER_TIMEOUT", "The video took too long. You were not charged.");
      } else {
        const w = await this.poll(data, now);
        if (w === "lost") await finish("WORKER_LOST_JOB", "The video service restarted and lost your video. You were not charged.");
        else if (w === "down") await finish("WORKER_UNAVAILABLE", "The video service is offline. You were not charged.");
        else if (w) status = await this.applyWorker(id, data, w, status);
      }
    }
    // 2. single-scene regenerations
    if (Object.values(data.regens).some((r) => r.status === "running")) status = await this.refreshRegens(id, data, status, now);
    await this.d.repo.save(id, status, data);
  }

  /** Returns the worker's view, or "lost" (it forgot the job), "down" (unreachable for too long), or undefined (a blip). */
  private async poll(data: LiveData, now: number): Promise<WorkerVideo | "lost" | "down" | undefined> {
    try {
      const w = await this.d.worker.getVideo(data.workerVideoId!);
      data.lastWorkerOkAt = now;
      return w;
    } catch (e) {
      if (e instanceof WorkerHttpError && e.status === 404) return "lost";
      if (now - data.lastWorkerOkAt > (this.d.workerLossMs ?? 3 * 60_000)) return "down";
      if (e instanceof WorkerUnreachable || e instanceof WorkerHttpError) return undefined;
      throw e;
    }
  }

  private async applyWorker(id: string, data: LiveData, w: WorkerVideo, status: string): Promise<string> {
    for (const ws of w.scenes) {
      const s = data.scenes.find((x) => x.index === ws.index);
      if (s) Object.assign(s, { state: ws.state, progress: ws.progress, attempt: ws.attempt, revision: ws.revision, errorCode: ws.error?.code });
    }
    data.progress = Math.max(data.progress, w.progress);
    data.stage = w.status === "composing" ? "finishing" : "rendering";

    if (w.status === "failed") {
      await this.releaseAll(id, data);
      data.error = { code: w.error?.code ?? "MODEL_FAILED", reasons: prettyReasons(w.error?.message) };
      data.stage = "done"; data.progress = 1;
      return "failed";
    }
    if (w.status !== "succeeded") return status;

    // The video is ready: store it, then charge for the scenes that were delivered and refund the rest.
    try {
      data.outputUrl = await this.d.files.put(`${id}-${this.now()}.mp4`, await this.d.worker.getVideoFile(data.workerVideoId!));
    } catch (e) {
      if (e instanceof WorkerUnreachable || e instanceof WorkerHttpError) return status; // try again on the next check
      throw e;
    }
    for (const s of data.scenes) {
      if (s.credits <= 0 || s.settled) continue;
      if (s.state === "done") {
        await this.d.ledger.capture(id, s.credits, `capture:${id}:${s.index}`);
        s.settled = "captured"; data.creditsCharged += s.credits;
      } else {
        await this.d.ledger.release(id, s.credits, `release:${id}:${s.index}`);
        s.settled = "released"; data.creditsRefunded += s.credits;
      }
    }
    data.stage = "done"; data.progress = 1;
    return data.scenes.every((s) => s.state === "done") ? "succeeded" : "partial";
  }

  private async refreshRegens(id: string, data: LiveData, status: string, now: number): Promise<string> {
    let w: WorkerVideo | "lost" | "down" | undefined;
    w = await this.poll(data, now);
    for (const r of Object.values(data.regens).filter((x) => x.status === "running")) {
      const outcome = w === "lost" || w === "down" ? "failed" : w?.regens[r.workerRegenId];
      if (!outcome || outcome === "running") continue;
      if (outcome === "failed") {
        await this.d.ledger.release(id, r.cost, `regen-release:${r.key}`);
        data.creditsRefunded += r.cost; r.status = "failed";
        continue;
      }
      try {
        data.outputUrl = await this.d.files.put(`${id}-${this.now()}.mp4`, await this.d.worker.getVideoFile(data.workerVideoId!));
      } catch (e) {
        if (e instanceof WorkerUnreachable || e instanceof WorkerHttpError) continue; // next check
        throw e;
      }
      await this.d.ledger.capture(id, r.cost, `regen-capture:${r.key}`);
      data.creditsCharged += r.cost; r.status = "succeeded";
      const s = data.scenes.find((x) => x.index === r.sceneIndex);
      if (s && w && w !== "lost" && w !== "down") Object.assign(s, { state: "done", revision: w.scenes.find((x) => x.index === s.index)?.revision ?? s.revision + 1, errorCode: undefined });
    }
    if (w && w !== "lost" && w !== "down") {
      for (const s of data.scenes) {
        const ws = w.scenes.find((x) => x.index === s.index);
        if (ws && !Object.values(data.regens).some((r) => r.status === "running" && r.sceneIndex === s.index)) Object.assign(s, { state: ws.state, progress: ws.progress, attempt: ws.attempt, revision: ws.revision });
      }
    }
    if (status === "succeeded" || status === "partial") return data.scenes.every((s) => s.state === "done") ? "succeeded" : "partial";
    return status;
  }

  // ---------------------------------------------------------------------------------------------------- regenerate
  async regenerate(c: Caller, id: string, index: number, key: string): Promise<RegenOutcome> {
    const row0 = await this.d.repo.load(id);
    if (!row0 || row0.userId !== c.userId) throw new ApiError(404, "Video not found.", "NOT_FOUND");
    let row: GenRow | null = null;
    for (let tries = 0; tries < 20 && !row; tries++) {
      row = await this.d.repo.lease(id, this.now());
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    if (!row) throw new ApiError(409, "This video is being updated. Try again in a moment.", "SCENE_BUSY");
    const { data } = row;
    try {
      const rkey = `${c.userId}:${key}`;
      if (data.regens[rkey]) return { ok: data.regens[rkey]!.status !== "failed", creditsCharged: 0, pending: data.regens[rkey]!.status === "running" };
      if (row.status !== "succeeded" && row.status !== "partial") throw new ApiError(409, `The video is ${row.status}.`, "NOT_FINISHED");
      const scene = data.scenes.find((s) => s.index === index);
      if (!scene) throw new ApiError(404, `There is no scene ${index}.`, "BAD_SCENE");
      if (Object.values(data.regens).some((r) => r.status === "running")) throw new ApiError(409, "A scene is already regenerating.", "SCENE_BUSY");
      if (!data.model || !data.workerVideoId) throw new ApiError(409, "This video can't be regenerated.", "NOT_FINISHED");

      const cost = Math.ceil(data.model.rate * scene.durationSeconds);
      try {
        await this.d.ledger.reserve(c.userId, id, cost, `regen-reserve:${rkey}`);
      } catch (e) {
        if (e instanceof InsufficientCreditsError) throw new ApiError(402, e.message, "INSUFFICIENT_CREDITS");
        throw e;
      }
      const plan = CreativePlanSchema.parse(data.request.creativePlan);
      let workerRegenId: string;
      try {
        workerRegenId = await this.d.worker.regenerate(data.workerVideoId, index, {
          prompt: buildPrompt(this.sceneReq(id, plan, index, data.request.mode, data.request.aspectRatio, scene.action)),
          seed: Number(`${Date.now()}`.slice(-9)),
        });
      } catch (e) {
        await this.d.ledger.release(id, cost, `regen-release:${rkey}`);
        if (e instanceof WorkerHttpError && e.status === 409) throw new ApiError(409, "A scene is already regenerating.", "SCENE_BUSY");
        throw new ApiError(503, "The video service is busy or offline. You were not charged.", "WORKER_UNAVAILABLE");
      }
      data.regens[rkey] = { workerRegenId, sceneIndex: index, cost, key: rkey, status: "running" } satisfies RegenRecord;
      scene.state = "rendering"; scene.progress = 0;
      return { ok: true, creditsCharged: 0, pending: true };
    } finally {
      await this.d.repo.save(id, row.status, data); // also releases the lease
    }
  }

  // ---------------------------------------------------------------------------------------------------- rate / view model
  async rate(c: Caller, id: string, value: "up" | "down"): Promise<boolean> {
    const row = await this.d.repo.load(id);
    if (!row || row.userId !== c.userId) return false;
    await this.d.repo.rate(id, c.userId, value);
    return true;
  }

  private async toView(row: GenRow, c: Caller): Promise<GenerationView> {
    const { data } = row;
    const busyScenes = new Set(Object.values(data.regens).filter((r) => r.status === "running").map((r) => r.sceneIndex));
    return {
      id: row.id, status: row.status, stage: data.stage, progress: Math.round(data.progress * 100),
      scenes: data.scenes.map((s) => ({
        index: s.index, durationSeconds: s.durationSeconds, action: s.action,
        state: busyScenes.has(s.index) ? "rendering" : s.state, progress: Math.round(s.progress * 100), attempt: s.attempt,
        modelId: data.model?.id, modelName: data.model?.name, regenCredits: data.model ? Math.ceil(data.model.rate * s.durationSeconds) : 0, busy: busyScenes.has(s.index),
      })),
      credits: { quoted: data.creditsQuoted, charged: data.creditsCharged, refunded: data.creditsRefunded },
      quote: data.quote, modelName: data.quote?.lines[0]?.label, outputUri: data.outputUrl,
      error: data.error, rating: await this.d.repo.rating(row.id), balance: await this.d.ledger.balance(c.userId),
    };
  }
}
