import {
  InsufficientCreditsError, LedgerInvariantError, type Balance, type Ledger, type LedgerEntry, type LedgerReason,
} from "@clipnova/core";
import type { Db } from "./index";

interface Row {
  id: number | string; user_id: string; generation_id: string | null; reason: LedgerReason; amount: number; idempotency_key: string; created_at: Date | string;
}

const toEntry = (r: Row): LedgerEntry => ({
  id: Number(r.id), userId: r.user_id, generationId: r.generation_id ?? undefined, reason: r.reason, amount: r.amount,
  idempotencyKey: r.idempotency_key, createdAt: new Date(r.created_at),
});

const assertAmount = (amount: number) => {
  if (!Number.isInteger(amount) || amount <= 0) throw new LedgerInvariantError(`amount must be a positive integer, got ${amount}`);
};

const BALANCE_SQL = `
  SELECT
    COALESCE(SUM(CASE reason WHEN 'grant' THEN amount WHEN 'release' THEN amount WHEN 'reserve' THEN -amount ELSE 0 END), 0)::int AS available,
    COALESCE(SUM(CASE reason WHEN 'reserve' THEN amount WHEN 'capture' THEN -amount WHEN 'release' THEN -amount ELSE 0 END), 0)::int AS held,
    COALESCE(SUM(CASE WHEN reason = 'capture' THEN amount ELSE 0 END), 0)::int AS spent
  FROM ledger_entries WHERE `;

/**
 * Credit ledger on Postgres. Append-only; every write carries a unique idempotency key, so a retried request
 * returns the original entry. Writes that depend on a balance take a per-user advisory lock inside a transaction,
 * so two simultaneous requests can never spend the same credits.
 */
export class SqlLedger implements Ledger {
  constructor(private readonly db: Db) {}

  private async existing(db: Db, key: string): Promise<LedgerEntry | undefined> {
    const r = await db.query<Row>("SELECT * FROM ledger_entries WHERE idempotency_key = $1", [key]);
    return r[0] && toEntry(r[0]);
  }

  private async insert(db: Db, userId: string, generationId: string | undefined, reason: LedgerReason, amount: number, key: string): Promise<LedgerEntry> {
    const r = await db.query<Row>(
      `INSERT INTO ledger_entries (user_id, generation_id, reason, amount, idempotency_key) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [userId, generationId ?? null, reason, amount, key]);
    return r[0] ? toEntry(r[0]) : (await this.existing(db, key))!;
  }

  async grant(userId: string, amount: number, key: string) {
    assertAmount(amount);
    return this.insert(this.db, userId, undefined, "grant", amount, key);
  }

  async reserve(userId: string, generationId: string, amount: number, key: string) {
    assertAmount(amount);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`user:${userId}`]);
      const again = await this.existing(tx, key);
      if (again) return again;
      const { available } = (await tx.query<Balance>(`${BALANCE_SQL} user_id = $1`, [userId]))[0]!;
      if (amount > available) throw new InsufficientCreditsError(amount, available);
      return this.insert(tx, userId, generationId, "reserve", amount, key);
    });
  }

  private async settle(reason: "capture" | "release", generationId: string, amount: number, key: string) {
    assertAmount(amount);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`gen:${generationId}`]);
      const again = await this.existing(tx, key);
      if (again) return again;
      const owner = (await tx.query<{ user_id: string }>("SELECT user_id FROM ledger_entries WHERE generation_id = $1 AND reason = 'reserve' LIMIT 1", [generationId]))[0];
      if (!owner) throw new LedgerInvariantError(`no reservation for generation ${generationId}`);
      const { held } = (await tx.query<Balance>(`${BALANCE_SQL} generation_id = $1`, [generationId]))[0]!;
      if (amount > held) throw new LedgerInvariantError(`${reason} ${amount} exceeds held ${held} for ${generationId}`);
      return this.insert(tx, owner.user_id, generationId, reason, amount, key);
    });
  }

  capture(generationId: string, amount: number, key: string) { return this.settle("capture", generationId, amount, key); }
  release(generationId: string, amount: number, key: string) { return this.settle("release", generationId, amount, key); }

  async balance(userId: string): Promise<Balance> {
    return (await this.db.query<Balance>(`${BALANCE_SQL} user_id = $1`, [userId]))[0]!;
  }
  async heldFor(generationId: string): Promise<number> {
    return (await this.db.query<Balance>(`${BALANCE_SQL} generation_id = $1`, [generationId]))[0]!.held;
  }
  async entries(userId: string): Promise<LedgerEntry[]> {
    return (await this.db.query<Row>("SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY id", [userId])).map(toEntry);
  }
}
