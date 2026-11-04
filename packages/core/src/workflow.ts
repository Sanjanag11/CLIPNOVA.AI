import type { Ledger } from "./ledger.js";
import { InsufficientCreditsError } from "./ledger.js";
import { ModelError, type ModelRegistry, type SceneResult, type VideoModelAdapter } from "./models.js";
import { checkPlanAllows, quoteCredits, type Addons, type Plan, type PricingConfig, type Quote } from "./plans.js";
import { validatePlanIntegrity, type AspectRatio, type CreativePlan, type Mode } from "./plan.js";
import { allocateCredits } from "./scenes.js";

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
  outputUri?: string;
  errorCode?: string;
  rejectionReasons?: string[];
}

export type WorkflowEvent =
  | { type: "status"; generationId: string; status: GenerationStatus }
  | { type: "scene_started"; generationId: string; index: number; modelId: string; attempt: number }
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
  save(g: Generation): void;
  activeCount(userId: string): number;
}

export class InMemoryGenerationStore implements GenerationStore {
  private byKey = new Map<string, Generation>();
  findByIdempotencyKey(key: string) { return this.byKey.get(key); }
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

export async function runGeneration(deps: WorkflowDeps, req: GenerationRequest): Promise<Generation> {
  // 1. Duplicate-request protection: same key returns the same generation.
  const existing = deps.store.findByIdempotencyKey(req.idempotencyKey);
  if (existing) return existing;

  const gen: Generation = {
    id: deps.newId(), userId: req.userId, idempotencyKey: req.idempotencyKey,
    status: "running", creditsQuoted: 0, creditsCharged: 0, creditsRefunded: 0, scenes: [],
  };
  const reject = (reasons: string[], code: string): Generation => {
    gen.status = "rejected"; gen.errorCode = code; gen.rejectionReasons = reasons;
    deps.store.save(gen);
    deps.emit?.({ type: "status", generationId: gen.id, status: "rejected" });
    return gen;
  };

  // 2. Cheap validation before any money moves.
  const planIssues = [
    ...validatePlanIntegrity(req.creativePlan),
    ...checkPlanAllows(req.plan, req.mode, req.durationSeconds),
  ];
  const sceneTotal = req.creativePlan.scenes.reduce((a, s) => a + s.durationSeconds, 0);
  if (sceneTotal !== req.durationSeconds) {
    planIssues.push(`scene durations sum to ${sceneTotal}s but ${req.durationSeconds}s was requested`);
  }
  if (planIssues.length) return reject(planIssues, "INVALID_REQUEST");

  if (deps.store.activeCount(req.userId) >= req.plan.maxConcurrentGenerations) {
    return reject([`concurrency limit ${req.plan.maxConcurrentGenerations} reached`], "CONCURRENCY_LIMIT");
  }

  // Register the generation BEFORE the first await so a concurrent duplicate
  // submit (double click, client retry) finds it and returns the same job.
  deps.store.save(gen);

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

    for (const scene of req.creativePlan.scenes) {
      const outcome: SceneOutcome = { index: scene.index, status: "failed", attempts: 0, credits: credits[scene.index] ?? 0 };
      scene: for (const adapter of eligible) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          outcome.attempts++;
          deps.emit?.({ type: "scene_started", generationId: gen.id, index: scene.index, modelId: adapter.profile.id, attempt });
          try {
            const sceneReq = {
              generationId: gen.id, scene, plan: req.creativePlan, mode: req.mode,
              aspectRatio: req.aspectRatio, inputAssetIds: req.inputAssetIds ?? [],
              seed: scene.index * 1000 + outcome.attempts, attempt,
            };
            const issues = adapter.validate(sceneReq);
            if (issues.length) { outcome.errorCode = "ADAPTER_VALIDATION"; continue scene; }
            outcome.result = await adapter.generate(sceneReq, (fraction) =>
              deps.emit?.({ type: "scene_progress", generationId: gen.id, index: scene.index, fraction }));
            outcome.status = "succeeded"; outcome.modelId = adapter.profile.id; outcome.errorCode = undefined;
            break scene;
          } catch (e) {
            const me = e instanceof ModelError ? e : new ModelError(String(e), true, "UNKNOWN");
            outcome.errorCode = me.code;
            if (!me.retryable) continue scene; // go to the next model
          }
        }
      }
      deps.emit?.({ type: "scene_done", generationId: gen.id, index: scene.index, ok: outcome.status === "succeeded" });
      gen.scenes.push(outcome);
    }

    const ok = gen.scenes.filter((s) => s.status === "succeeded");
    if (ok.length === 0) {
      await releaseAll(deps, gen);
      return await finish("failed", gen.scenes[0]?.errorCode ?? "ALL_SCENES_FAILED");
    }

    // 7. Compose, then charge only for what was delivered.
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

async function releaseAll(deps: WorkflowDeps, gen: Generation): Promise<void> {
  const held = await deps.ledger.heldFor(gen.id);
  if (held > 0) {
    await deps.ledger.release(gen.id, held, `release-all:${gen.id}`);
    gen.creditsRefunded += held;
  }
}

export type { VideoModelAdapter };
