/** Client for the inference worker's whole-video API (workers/inference). Used by the live engine only. */

export class WorkerUnreachable extends Error {}
export class WorkerHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface WorkerScene { index: number; state: "queued" | "rendering" | "retrying" | "done" | "failed"; progress: number; attempt: number; revision: number; error?: { code: string; message?: string; retryable?: boolean } }
export interface WorkerVideo {
  status: "queued" | "running" | "composing" | "succeeded" | "failed";
  progress: number; gpuSeconds: number; scenes: WorkerScene[]; regens: Record<string, "running" | "succeeded" | "failed">;
  error?: { code: string; message?: string; retryable?: boolean };
}

export interface WorkerClientOptions { baseUrl: string; token?: string; fetch?: typeof fetch; jsonTimeoutMs?: number; fileTimeoutMs?: number }

export class WorkerClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: WorkerClientOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async call(path: string, init: RequestInit = {}, timeoutMs = this.o.jsonTimeoutMs ?? 10_000): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (init.body) headers["content-type"] = "application/json";
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    let res: Response;
    try {
      res = await this.f(`${this.o.baseUrl.replace(/\/+$/, "")}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new WorkerUnreachable(e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new WorkerHttpError(res.status, (await res.text().catch(() => "")).slice(0, 200));
    return res;
  }

  async models(): Promise<{ id: string }[]> {
    return ((await (await this.call("/v1/models")).json()) as { models: { id: string }[] }).models;
  }

  async createVideo(body: { model: string; aspectRatio: string; watermark: boolean; seed: number; scenes: { prompt: string; seconds: number }[] }): Promise<string> {
    // A cold GPU container can take a while to start, so creating a video gets a long timeout.
    return ((await (await this.call("/v1/videos", { method: "POST", body: JSON.stringify(body) }, 90_000)).json()) as { videoId: string }).videoId;
  }

  async getVideo(id: string): Promise<WorkerVideo> {
    return (await (await this.call(`/v1/videos/${encodeURIComponent(id)}`)).json()) as WorkerVideo;
  }

  async getVideoFile(id: string): Promise<Uint8Array> {
    const res = await this.call(`/v1/videos/${encodeURIComponent(id)}/video`, {}, this.o.fileTimeoutMs ?? 60_000);
    return new Uint8Array(await res.arrayBuffer());
  }

  async regenerate(id: string, index: number, body: { prompt?: string; seed?: number }): Promise<string> {
    const res = await this.call(`/v1/videos/${encodeURIComponent(id)}/scenes/${index}/regenerate`, { method: "POST", body: JSON.stringify(body) });
    return ((await res.json()) as { regenId: string }).regenId;
  }
}
