import {
  ModelError, type CapabilityProfile, type SceneRequest, type SceneResult, type VideoModelAdapter,
} from "../models";

/** Where finished scene videos are kept. The web app provides a disk (dev) or object-storage (prod) implementation. */
export interface VideoStore {
  /** Saves the bytes and returns a URI the composer can read. */
  save(key: string, bytes: Uint8Array): Promise<string>;
}

export interface HttpAdapterOptions {
  /** Base URL of a ClipNova inference worker, e.g. https://my-worker.example.com */
  baseUrl: string;
  /** Bearer token the worker expects. Never sent to the browser. */
  token?: string;
  /** The model's id on the worker (may differ from the app-level id). */
  workerModelId: string;
  store: VideoStore;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Give up on a scene after this long. */
  timeoutMs?: number;
  /** Optional: turns a non-English scene into English before it reaches the model (e.g. an IndicTrans2 service). */
  translate?: (text: string, fromLanguage: string) => Promise<string>;
}

interface JobStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  progress?: number;
  gpuSeconds?: number;
  error?: { code: string; message?: string; retryable?: boolean };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Builds the English prompt a video model sees from the model-agnostic scene.
 * Order matters to most models: subject and action first, then look, then camera.
 */
export function buildPrompt(req: SceneRequest, actionOverride?: string): string {
  const { scene, plan } = req;
  const chars = plan.characters.filter((c) => scene.characterIds.includes(c.id)).map((c) => `${c.name}, ${c.appearance}`);
  const set = plan.setting;
  const parts = [
    actionOverride ?? scene.action,
    chars.length ? `Characters: ${chars.join("; ")}` : "",
    [set.location, set.timeOfDay, set.lighting].filter(Boolean).join(", "),
    set.visualStyle ?? "",
    scene.camera ? `Camera: ${scene.camera}` : "",
    scene.motion ? `Motion: ${scene.motion}` : "",
    scene.continuityNotes ?? "",
    plan.rawInput.creativePrompt,
  ];
  return parts.map((p) => p.trim().replace(/[.\s]+$/, "")).filter(Boolean).join(". ").slice(0, 1800);
}

/** Talks to a ClipNova inference worker (workers/inference). One instance per model. */
export class HttpVideoAdapter implements VideoModelAdapter {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(public readonly profile: CapabilityProfile, private readonly o: HttpAdapterOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? defaultSleep;
  }

  validate(req: SceneRequest): string[] {
    const issues: string[] = [];
    const p = this.profile;
    if (req.scene.durationSeconds > p.maxClipSeconds) issues.push(`scene is ${req.scene.durationSeconds}s; ${p.name} renders at most ${p.maxClipSeconds}s`);
    if (!p.modes.includes(req.mode)) issues.push(`${p.name} does not support ${req.mode}`);
    if (!p.aspectRatios.includes(req.aspectRatio)) issues.push(`${p.name} does not support ${req.aspectRatio}`);
    if (req.mode !== "t2v") issues.push(`${req.mode} needs an uploaded input, which is not available yet`);
    return issues;
  }

  renderPrompt(req: SceneRequest): string {
    return buildPrompt(req);
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.o.token) h.authorization = `Bearer ${this.o.token}`;
    return h;
  }

  private url(path: string): string {
    return `${this.o.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.f(this.url(path), init);
    } catch (e) {
      throw new ModelError(`worker unreachable: ${e instanceof Error ? e.message : String(e)}`, true, "WORKER_UNAVAILABLE");
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
    // 429 (queue full) and 5xx are worth retrying; other 4xx mean this request will never work on this model.
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new ModelError(`${what} failed (${res.status}) ${detail}`, retryable, retryable ? "WORKER_UNAVAILABLE" : "WORKER_REJECTED");
  }

  async generate(req: SceneRequest, onProgress?: (fraction: number) => void): Promise<SceneResult> {
    let action: string | undefined;
    if (this.o.translate && req.plan.inputLanguage !== "en") {
      action = await this.o.translate(req.scene.action, req.plan.inputLanguage).catch(() => undefined);
    }
    const created = await this.call("/v1/jobs", {
      method: "POST", headers: this.headers(true),
      body: JSON.stringify({
        model: this.o.workerModelId, prompt: buildPrompt(req, action), seconds: req.scene.durationSeconds,
        aspectRatio: req.aspectRatio, seed: req.seed,
      }),
    });
    if (!created.ok) await this.fail(created, "creating the job");
    const { jobId } = (await created.json()) as { jobId: string };

    const deadline = Date.now() + (this.o.timeoutMs ?? 20 * 60_000);
    let status: JobStatus = { status: "queued" };
    while (status.status === "queued" || status.status === "running") {
      if (Date.now() > deadline) throw new ModelError("the worker took too long", true, "WORKER_TIMEOUT");
      await this.sleep(this.o.pollMs ?? 1500);
      const res = await this.call(`/v1/jobs/${encodeURIComponent(jobId)}`, { headers: this.headers() });
      if (res.status === 404) throw new ModelError("the worker lost the job (it may have restarted)", true, "WORKER_LOST_JOB");
      if (!res.ok) await this.fail(res, "checking the job");
      status = (await res.json()) as JobStatus;
      if (status.progress !== undefined) onProgress?.(Math.max(0, Math.min(0.99, status.progress)));
    }
    if (status.status === "failed") {
      throw new ModelError(status.error?.message ?? "the model failed", status.error?.retryable ?? true, status.error?.code ?? "MODEL_FAILED");
    }

    const video = await this.call(`/v1/jobs/${encodeURIComponent(jobId)}/video`, { headers: this.headers() });
    if (!video.ok) await this.fail(video, "downloading the video");
    const bytes = new Uint8Array(await video.arrayBuffer());
    if (bytes.length < 1024) throw new ModelError("the worker returned an empty video", true, "EMPTY_VIDEO");
    const uri = await this.o.store.save(`${req.generationId}-s${req.scene.index}-${req.seed}`, bytes);
    onProgress?.(1);
    return { outputUri: uri, durationSeconds: req.scene.durationSeconds, seed: req.seed, gpuSeconds: status.gpuSeconds ?? 0 };
  }

  async healthcheck(): Promise<boolean> {
    try {
      const r = await this.f(this.url("/healthz"), { headers: this.headers() });
      return r.ok;
    } catch {
      return false;
    }
  }
}
