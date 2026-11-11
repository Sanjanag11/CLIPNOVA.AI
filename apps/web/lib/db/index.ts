import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "../video-store";

/** The small slice of SQL we need. Implemented for Postgres (production) and embedded Postgres (local dev, tests). */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  generation_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('grant','reserve','capture','release')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger_entries (user_id);
CREATE INDEX IF NOT EXISTS ledger_generation ON ledger_entries (generation_id);
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generations_user_status ON generations (user_id, status);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  uid TEXT,
  user_id TEXT,
  name TEXT NOT NULL,
  props JSONB NOT NULL DEFAULT '{}'::jsonb,
  variants JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_name_ts ON events (name, ts);
CREATE INDEX IF NOT EXISTS events_uid ON events (uid);
CREATE TABLE IF NOT EXISTS ratings (
  generation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('up','down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

class PgDb implements Db {
  constructor(private readonly pool: import("pg").Pool) {}
  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(text, params)).rows as T[];
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Db = {
      query: async <R>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as R[],
      transaction: (inner) => inner(tx), // already inside a transaction
    };
    try {
      await client.query("BEGIN");
      const out = await fn(tx);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

class PgliteDb implements Db {
  constructor(private readonly db: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> }) {} // eslint-disable-line @typescript-eslint/no-explicit-any
  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query(text, params)).rows as T[];
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(async (t) => {
      const tx: Db = {
        query: async <R>(text: string, params: unknown[] = []) => (await t.query(text, params)).rows as R[],
        transaction: (inner) => inner(tx),
      };
      return fn(tx);
    });
  }
}

/** An in-process Postgres (PGlite). Used for local development (persisted to disk) and for tests (memory). */
export async function openEmbeddedDb(path?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (path) await mkdir(dirname(path), { recursive: true }); // PGlite does not create missing parent folders
  const pg = path ? new PGlite(path) : new PGlite();
  await pg.exec(SCHEMA);
  return new PgliteDb(pg as unknown as ConstructorParameters<typeof PgliteDb>[0]);
}

const g = globalThis as unknown as { __clipnovaDb?: Promise<Db> };

/**
 * The database for this process.
 *  - DATABASE_URL (or POSTGRES_URL): a Postgres server, e.g. Neon through the Vercel Marketplace. Required in production.
 *  - otherwise an embedded Postgres in the data directory, only outside production (or with CLIPNOVA_LOCAL_DB=1).
 */
export function getDb(): Promise<Db> {
  g.__clipnovaDb ??= (async () => {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (url) {
      const { Pool } = await import("pg");
      // Serverless: keep the pool tiny; use the provider's pooled connection string.
      const pool = new Pool({ connectionString: url, max: Number(process.env.CLIPNOVA_DB_POOL ?? 3), idleTimeoutMillis: 10_000 });
      await pool.query(SCHEMA);
      return new PgDb(pool);
    }
    if (process.env.NODE_ENV === "production" && process.env.CLIPNOVA_LOCAL_DB !== "1") {
      throw new Error("DATABASE_URL is not set. Add a Postgres database to the project (see docs/deploy-vercel.md).");
    }
    return openEmbeddedDb(join(dataDir(), "pglite"));
  })();
  g.__clipnovaDb.catch(() => { g.__clipnovaDb = undefined; }); // retry on the next request if setup failed
  return g.__clipnovaDb;
}
