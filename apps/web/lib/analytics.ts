import type { Db } from "./db";

/** What the browser may report. Server-only events (generation_started, generation_finished...) are never accepted from a client. */
export const CLIENT_EVENTS = new Set([
  "page_view", "create_view", "plan_requested", "plan_viewed", "generate_clicked", "video_played", "download_clicked",
  "regenerate_clicked", "rating_given", "reuse_clicked", "model_picker_opened", "error_shown",
]);

export type Props = Record<string, string | number | boolean>;

/** Accepts only small, flat, scalar properties, so nobody can stuff the database through the events endpoint. */
export function cleanProps(input: unknown): Props | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 12) return null;
  const out: Props = {};
  for (const [k, v] of entries) {
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(k)) return null;
    if (typeof v === "string") { if (v.length > 200) return null; out[k] = v; }
    else if (typeof v === "number") { if (!Number.isFinite(v)) return null; out[k] = v; }
    else if (typeof v === "boolean") out[k] = v;
    else return null;
  }
  return JSON.stringify(out).length <= 1500 ? out : null;
}

export interface EventInput {
  uid?: string;
  userId?: string;
  name: string;
  props?: Record<string, unknown>;
  variants?: Record<string, string>;
}

export type EventSink = (e: EventInput) => Promise<void>;

export async function recordEvent(db: Db, e: EventInput): Promise<void> {
  await db.query(
    "INSERT INTO events (uid, user_id, name, props, variants) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)",
    [e.uid ?? null, e.userId ?? null, e.name, JSON.stringify(e.props ?? {}), JSON.stringify(e.variants ?? {})],
  );
}

/** Analytics must never break a request: failures are logged and swallowed. */
export function safeSink(db: () => Promise<Db>): EventSink {
  return async (e) => {
    try {
      await recordEvent(await db(), e);
    } catch (err) {
      console.error("event not recorded", e.name, err instanceof Error ? err.message : err);
    }
  };
}

/** Fire-and-forget: a broken or missing sink must never affect a video, a charge or a response. */
export function safeEmit(sink: EventSink | undefined, e: EventInput): void {
  if (!sink) return;
  try { Promise.resolve(sink(e)).catch(() => {}); } catch { /* ignore */ }
}
