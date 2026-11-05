import type { Ledger } from "./ledger";
import { InsufficientCreditsError } from "./ledger";
import { ModelError, type ModelRegistry, type SceneResult, type VideoModelAdapter } from "./models";
import { checkPlanAllows, quoteCredits, type Addons, type Plan, type PricingConfig, type Quote } from "./plans";
import { validatePlanIntegrity, type AspectRatio, type CreativePlan, type Mode, type ScenePlan } from "./plan";
import { allocateCredits } from "./scenes";

export type GenerationStatus = "running" | "succeeded" | "partial" | "failed" | "rejected";

export interface GenerationRequest {
  userId: string;
  plan: Plan;
  idempotencyKey: string;
  mode: Mode;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  /** ISO country code of the user. Model licence territories are enforced against it. */
  region: string;
  /** A model the user picked; omit or "auto" to let ClipNova choose. */
  modelId?: string;
  addons: Addons;
  creativePlan: CreativePlan;
  inputAssetIds?: string[];
  /** 0-99, stable per user; drives gradual model rollouts. */
  rolloutBucket?: number;
}

export interface SceneOutcome {
  index: number;
  status: "succeeded" | "failed";
  modelId?: string;
  attempts: number;
  result?: SceneResult;
  errorCode?: string;
  credits: number;
  /** True while this scene is being regenerated. */
  busy?: boolean;
}

export interface Generation {
  id: string;
  userId: string;
  idempotencyKey: string;
  status: GenerationStatus;
  creditsQuoted: number;
  quote?: Quote;
  creditsCharged: number;
  creditsRefunded: number;
  scenes: SceneOutcome[];
  /** The request this generation ran, kept so single scenes can be regenerated. */
  request: GenerationRequest;
  regenKeys: string[];
  outputUri?: string;
  errorCode?: string;
  rejectionReasons?: string[];
}

export type WorkflowStage = "checking" | "rendering" | "finishing";

export type WorkflowEvent =
  | { type: "status"; generationId: string; status: GenerationStatus }
  | { type: "stage"; generationId: string; stage: WorkflowStage }
  | { type: "scene_started"; generationId: string; index: number; modelId: string; attempt: number }
  | { type: "scene_attempt_failed"; generationId: string; index: number; modelId: string; attempt: number; code: string }
  | { type: "scene_progress"; generationId: string; index: number; fraction: number }
  | { type: "scene_done"; generationId: string; index: number; ok: boolean };

export interface Moderator {
  /** Returns blocking categories (empty = allowed). */
  checkText(text: string): Promise<string[]>;
}

export interface Composer {
  compose(generationId: string, scenes: SceneResult[], opts: { aspectRatio: AspectRatio; watermark: boolean }): Promise<string>;
}

export interface GenerationStore {
  findByIdempotencyKey(key: string): Generation | undefined;
  findById(id: string): Generation | undefined;
  save(g: Generation): void;
  activeCount(userId: string): number;
}

export class InMemoryGenerationStore implements GenerationStore {
  private byKey = new Map<string, Generation>();
  findByIdempotencyKey(key: string) { return this.byKey.get(key); }
  findById(id: string) { return [...this.byKey.values()].find((g) => g.id === id); }
  save(g: Generation) { this.byKey.set(g.idempotencyKey, g); }
  activeCount(userId: string) {
    return [...this.byKey.values()].filter((g) => g.userId === userId && g.status === "running").length;
  }
}

export interface WorkflowDeps {
  ledger: Ledger;
  registry: ModelRegistry;
  store: GenerationStore;
  moderator: Moderator;
  composer: Composer;
  pricing: PricingConfig;
  newId: () => string;
  emit?: (e: WorkflowEvent) => void;
  /** Attempts per model before falling back to the next candidate. */
  maxAttemptsPerModel?: number;
}

/** Rules every generation request must satisfy, whichever engine runs it. Returns human-readable problems. */
export function validateGenerationRequest(req: Pick<GenerationRequest, "creativePlan" | "plan" | "mode" | "durationSeconds">): string[] {
  const issues = [
    ...validatePlanIntegrity(req.creativePlan),
    ...checkPlanAllows(req.plan, req.mode, req.durationSeconds),
  ];
  const sceneTotal = req.creativePlan.scenes.reduce((a, s) => a + s.durationSeconds, 0);
  if (sceneTotal !== req.durationSeconds) {
    issues.push(`scene durations sum to ${sceneTotal}s but ${req.durationSeconds}s was requested`);
  }
  return issues;
}

export async function runGeneration(deps: WorkflowDeps, req: GenerationRequest): Promise<Generation> {
  // 1. Duplicate-request protection: same key returns the same generation.
  const existing = deps.store.findByIdempotencyKey(req.idempotencyKey);
  if (existing) return existing;

  const gen: Generation = {
    id: deps.newId(), userId: req.userId, idempotencyKey: req.idempotencyKey,
    status: "running", creditsQuoted: 0, creditsCharged: 0, creditsRefunded: 0, scenes: [],
    request: req, regenKeys: [],
  };
  const reject = (reasons: string[], code: string): Generation => {
    gen.status = "rejected"; gen.errorCode = code; gen.rejectionReasons = reasons;
    deps.store.save(gen);
    deps.emit?.({ type: "status", generationId: gen.id, status: "rejected" });
    return gen;
  };

  // 2. Cheap validation before any money moves.
  const planIssues = validateGenerationRequest(req);
  if (planIssues.length) return reject(planIssues, "INVALID_REQUEST");

  if (deps.store.activeCount(req.userId) >= req.plan.maxConcurrentGenerations) {
    return reject([`concurrency limit ${req.plan.maxConcurrentGenerations} reached`], "CONCURRENCY_LIMIT");
  }

  // Register the generation BEFORE the first await so a concurrent duplicate
  // submit (double click, client retry) finds it and returns the same job.
  deps.store.save(gen);
  deps.emit?.({ type: "stage", generationId: gen.id, stage: "checking" });

  // 3. Moderation gate on everything the user wrote.
  const text = [req.creativePlan.rawInput.description, req.creativePlan.rawInput.creativePrompt,
    ...req.creativePlan.scenes.map((s) => s.action)].join("\n");
  const blocked = await deps.moderator.checkText(text);
  if (blocked.length) return reject(blocked, "MODERATION_BLOCKED");

  // 4. Model selection.
  const eligible = deps.registry.select({
    mode: req.mode, aspectRatio: req.aspectRatio, region: req.region, bucket: req.rolloutBucket,
    modelId: req.modelId, maxSceneSeconds: Math.max(...req.creativePlan.scenes.map((s) => s.durationSeconds)),
  });
  if (!eligible.length) return reject(["no eligible model for this request, mode and region"], "NO_MODEL");

  // 5. Quote + reserve credits (the only place money is checked).
  // Quoted on the primary model; a pricier fallback is absorbed by ClipNova, never the user.
  const primary = eligible[0]!.profile;
  gen.quote = quoteCredits(deps.pricing, primary.name, primary.creditsPerSecond, req.durationSeconds, req.addons);
  gen.creditsQuoted = gen.quote.total;
  try {
    await deps.ledger.reserve(req.userId, gen.id, gen.creditsQuoted, `reserve:${req.idempotencyKey}`);
  } catch (e) {
    if (e instanceof InsufficientCreditsError) return reject([e.message], "INSUFFICIENT_CREDITS");
    throw e;
  }
  deps.store.save(gen);
  deps.emit?.({ type: "status", generationId: gen.id, status: "running" });

  const finish = async (status: GenerationStatus, errorCode?: string): Promise<Generation> => {
    gen.status = status;
    if (errorCode) gen.errorCode = errorCode;
    deps.store.save(gen);
    deps.emit?.({ type: "status", generationId: gen.id, status });
    return gen;
  };

  try {
    // 6. Render scenes. Failed scenes are retried, then rerouted to the next model.
    const weights = req.creativePlan.scenes.map((s) => s.durationSeconds);
    const credits = allocateCredits(gen.creditsQuoted, weights);
    const maxAttempts = deps.maxAttemptsPerModel ?? 2;

    deps.emit?.({ type: "stage", generationId: gen.id, stage: "rendering" });
    for (const scene of req.creativePlan.scenes) {
      const r = await renderScene(deps, gen.id, req, scene, eligible, maxAttempts, 0);
      deps.emit?.({ type: "scene_done", generationId: gen.id, index: scene.index, ok: r.status === "succeeded" });
      gen.scenes.push({ index: scene.index, credits: credits[scene.index] ?? 0, ...r });
    }

    const ok = gen.scenes.filter((s) => s.status === "succeeded");
    if (ok.length === 0) {
      await releaseAll(deps, gen);
      return await finish("failed", gen.scenes[0]?.errorCode ?? "ALL_SCENES_FAILED");
    }

    // 7. Compose, then charge only for what was delivered.
    deps.emit?.({ type: "stage", generationId: gen.id, stage: "finishing" });
    let outputUri: string;
    try {
      outputUri = await deps.composer.compose(gen.id, ok.map((s) => s.result!), {
        aspectRatio: req.aspectRatio, watermark: req.plan.watermark,
      });
    } catch {
      await releaseAll(deps, gen);
      return await finish("failed", "COMPOSE_FAILED");
    }
    gen.outputUri = outputUri;

    for (const s of gen.scenes) {
      if (s.credits <= 0) continue;
      if (s.status === "succeeded") {
        await deps.ledger.capture(gen.id, s.credits, `capture:${gen.id}:${s.index}`);
        gen.creditsCharged += s.credits;
      } else {
        await deps.ledger.release(gen.id, s.credits, `release:${gen.id}:${s.index}`);
        gen.creditsRefunded += s.credits;
      }
    }
    return await finish(ok.length === gen.scenes.length ? "succeeded" : "partial");
  } catch (e) {
    // Anything unexpected: never leave credits held.
    await releaseAll(deps, gen).catch(() => undefined);
    await finish("failed", "INTERNAL_ERROR");
    throw e;
  }
}

type SceneRender = Pick<SceneOutcome, "status" | "modelId" | "attempts" | "result" | "errorCode">;

/** Renders one scene: retries on the same model, then reroutes to the next eligible model. */
async function renderScene(
  deps: WorkflowDeps, generationId: string, req: GenerationRequest, scene: ScenePlan,
  eligible: VideoModelAdapter[], maxAttempts: number, seedOffset: number,
): Promise<SceneRender> {
  const out: SceneRender = { status: "failed", attempts: 0 };
  scene: for (const adapter of eligible) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      out.attempts++;
      deps.emit?.({ type: "scene_started", generationId, index: scene.index, modelId: adapter.profile.id, attempt: out.attempts });
      try {
        const sceneReq = {
          generationId, scene, plan: req.creativePlan, mode: req.mode,
          aspectRatio: req.aspectRatio, inputAssetIds: req.inputAssetIds ?? [],
          seed: scene.index * 1000 + seedOffset + out.attempts, attempt,
        };
        const issues = adapter.validate(sceneReq);
        if (issues.length) {
          out.errorCode = "ADAPTER_VALIDATION";
          deps.emit?.({ type: "scene_attempt_failed", generationId, index: scene.index, modelId: adapter.profile.id, attempt: out.attempts, code: out.errorCode });
          continue scene;
        }
        out.result = await adapter.generate(sceneReq, (fraction) =>
          deps.emit?.({ type: "scene_progress", generationId, index: scene.index, fraction }));
        out.status = "succeeded"; out.modelId = adapter.profile.id; out.errorCode = undefined;
        break scene;
      } catch (e) {
        const me = e instanceof ModelError ? e : new ModelError(String(e), true, "UNKNOWN");
        out.errorCode = me.code;
        deps.emit?.({ type: "scene_attempt_failed", generationId, index: scene.index, modelId: adapter.profile.id, attempt: out.attempts, code: me.code });
        if (!me.retryable) continue scene; // go to the next model
      }
    }
  }
  return out;
}

export type RegenErrorCode = "NOT_FOUND" | "NOT_FINISHED" | "BAD_SCENE" | "SCENE_BUSY" | "INSUFFICIENT_CREDITS" | "NO_MODEL";
export class RegenError extends Error {
  constructor(public readonly code: RegenErrorCode, message: string) {
    super(message);
    this.name = "RegenError";
  }
}

export interface RegenResult { generation: Generation; ok: boolean; creditsCharged: number; errorCode?: string }

/**
 * Regenerates ONE scene of a finished generation. Charges only that scene (reserve, then capture on
 * success or release on failure) and re-composes the video. A repeated idempotency key is a no-op.
 */
export async function regenerateScene(
  deps: WorkflowDeps, generationId: string, sceneIndex: number, idempotencyKey: string,
): Promise<RegenResult> {
  const gen = deps.store.findById(generationId);
  if (!gen) throw new RegenError("NOT_FOUND", `unknown generation ${generationId}`);
  if (gen.regenKeys.includes(idempotencyKey)) return { generation: gen, ok: true, creditsCharged: 0 };
  if (gen.status === "running" || gen.status === "rejected") throw new RegenError("NOT_FINISHED", `generation is ${gen.status}`);
  const scene = gen.scenes.find((s) => s.index === sceneIndex);
  const planScene = gen.request.creativePlan.scenes.find((s) => s.index === sceneIndex);
  if (!scene || !planScene) throw new RegenError("BAD_SCENE", `no scene ${sceneIndex}`);
  if (scene.busy) throw new RegenError("SCENE_BUSY", `scene ${sceneIndex} is already regenerating`);

  const req = gen.request;
  const eligible = deps.registry.select({
    mode: req.mode, aspectRatio: req.aspectRatio, region: req.region, bucket: req.rolloutBucket,
    modelId: req.modelId, maxSceneSeconds: planScene.durationSeconds,
  });
  if (!eligible.length) throw new RegenError("NO_MODEL", "no eligible model for this scene and region");
  const cost = Math.ceil(eligible[0]!.profile.creditsPerSecond * planScene.durationSeconds);

  try {
    await deps.ledger.reserve(gen.userId, gen.id, cost, `regen-reserve:${idempotencyKey}`);
  } catch (e) {
    if (e instanceof InsufficientCreditsError) throw new RegenError("INSUFFICIENT_CREDITS", e.message);
    throw e;
  }
  gen.regenKeys.push(idempotencyKey);
  scene.busy = true;
  let settled = false;
  const release = async () => {
    if (settled) return;
    settled = true;
    await deps.ledger.release(gen.id, cost, `regen-release:${idempotencyKey}`);
    gen.creditsRefunded += cost;
  };
  try {
    const attemptsSoFar = scene.attempts;
    const r = await renderScene(deps, gen.id, req, planScene, eligible, deps.maxAttemptsPerModel ?? 2, attemptsSoFar * 10);
    deps.emit?.({ type: "scene_done", generationId: gen.id, index: sceneIndex, ok: r.status === "succeeded" });
    if (r.status !== "succeeded") {
      await release();
      return { generation: gen, ok: false, creditsCharged: 0, errorCode: r.errorCode };
    }
    const updated = gen.scenes.map((s) => (s.index === sceneIndex ? { ...s, ...r, attempts: s.attempts + r.attempts } : s));
    let outputUri: string;
    try {
      outputUri = await deps.composer.compose(gen.id, updated.filter((s) => s.status === "succeeded").map((s) => s.result!), {
        aspectRatio: req.aspectRatio, watermark: req.plan.watermark,
      });
    } catch {
      await release();
      return { generation: gen, ok: false, creditsCharged: 0, errorCode: "COMPOSE_FAILED" };
    }
    await deps.ledger.capture(gen.id, cost, `regen-capture:${idempotencyKey}`);
    settled = true;
    gen.creditsCharged += cost;
    Object.assign(scene, updated.find((s) => s.index === sceneIndex)!);
    gen.outputUri = outputUri;
    gen.status = gen.scenes.every((s) => s.status === "succeeded") ? "succeeded" : "partial";
    deps.store.save(gen);
    return { generation: gen, ok: true, creditsCharged: cost };
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  } finally {
    scene.busy = false;
  }
}

async function releaseAll(deps: WorkflowDeps, gen: Generation): Promise<void> {
  const held = await deps.ledger.heldFor(gen.id);
  if (held > 0) {
    await deps.ledger.release(gen.id, held, `release-all:${gen.id}`);
    gen.creditsRefunded += held;
  }
}

export type { VideoModelAdapter };
