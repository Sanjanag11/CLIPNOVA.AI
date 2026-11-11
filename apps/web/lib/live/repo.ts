import type { Quote } from "@clipnova/core";
import type { Db } from "../db";

export type SceneState = "queued" | "rendering" | "retrying" | "done" | "failed";

export interface LiveScene {
  index: number; durationSeconds: number; action: string; state: SceneState; progress: number; attempt: number; revision: number;
  errorCode?: string; credits: number; settled?: "captured" | "released";
}
export interface RegenRecord { workerRegenId: string; sceneIndex: number; cost: number; key: string; status: "running" | "succeeded" | "failed"; reported?: boolean }

/** Everything about one generation, stored as JSON so the engine stays stateless between requests. */
export interface LiveData {
  userId: string;
  request: { mode: string; durationSeconds: number; aspectRatio: string; modelId?: string; region: string; planId: string; watermark: boolean; creativePlan: unknown };
  model?: { id: string; name: string; workerId: string; rate: number };
  quote?: Quote; creditsQuoted: number; creditsCharged: number; creditsRefunded: number;
  workerVideoId?: string;
  stage: "checking" | "rendering" | "finishing" | "done";
  progress: number;
  scenes: LiveScene[];
  outputUrl?: string;
  error?: { code: string; reasons: string[] };
  startedAt: number; lastWorkerOkAt: number;
  regens: Record<string, RegenRecord>;
  /** The tester's A/B variants when the video was made (also stamped on every event). */
  variants?: Record<string, string>;
  uid?: string;
  /** Set once the "finished" analytics event has been sent, so settling twice can never double-count. */
  finishedEvent?: boolean;
  lease?: number;
}

export interface GenRow { id: string; userId: string; status: string; data: LiveData }

interface Raw { id: string; user_id: string; status: string; data: LiveData }
const toRow = (r: Raw): GenRow => ({ id: r.id, userId: r.user_id, status: r.status, data: r.data });

export class GenerationRepo {
  constructor(private readonly db: Db) {}

  /** Creates the row, or returns the existing one for this idempotency key (duplicate-submit protection). */
  async insertNew(id: string, userId: string, key: string, status: string, data: LiveData): Promise<{ row: GenRow; created: boolean }> {
    const ins = await this.db.query<Raw>(
      `INSERT INTO generations (id, user_id, idempotency_key, status, data) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [id, userId, key, status, JSON.stringify(data)]);
    if (ins[0]) return { row: toRow(ins[0]), created: true };
    return { row: toRow((await this.db.query<Raw>("SELECT * FROM generations WHERE idempotency_key = $1", [key]))[0]!), created: false };
  }

  async load(id: string): Promise<GenRow | null> {
    const r = await this.db.query<Raw>("SELECT * FROM generations WHERE id = $1", [id]);
    return r[0] ? toRow(r[0]) : null;
  }

  /** Writes new state and releases the lease (the lease lives inside `data`). */
  async save(id: string, status: string, data: LiveData): Promise<void> {
    const { lease: _lease, ...clean } = data;
    await this.db.query("UPDATE generations SET status = $2, data = $3::jsonb, updated_at = now() WHERE id = $1", [id, status, JSON.stringify(clean)]);
  }

  /** Takes a 30 s lease so only one request at a time settles credits or stores a video. Returns null if someone else holds it. */
  async lease(id: string, now: number, ttlMs = 30_000): Promise<GenRow | null> {
    const r = await this.db.query<Raw>(
      `UPDATE generations SET data = jsonb_set(data, '{lease}', to_jsonb($2::bigint))
       WHERE id = $1 AND (data->>'lease' IS NULL OR (data->>'lease')::bigint < $3) RETURNING *`, [id, now, now - ttlMs]);
    return r[0] ? toRow(r[0]) : null;
  }

  async countRunning(userId: string): Promise<number> {
    return Number((await this.db.query<{ n: number | string }>("SELECT count(*)::int AS n FROM generations WHERE user_id = $1 AND status = 'running'", [userId]))[0]!.n);
  }

  async rate(id: string, userId: string, value: "up" | "down"): Promise<void> {
    await this.db.query(
      `INSERT INTO ratings (generation_id, user_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (generation_id) DO UPDATE SET value = EXCLUDED.value`, [id, userId, value]);
  }

  async rating(id: string): Promise<"up" | "down" | undefined> {
    return (await this.db.query<{ value: "up" | "down" }>("SELECT value FROM ratings WHERE generation_id = $1", [id]))[0]?.value;
  }
}
