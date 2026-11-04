/**
 * Append-only credit ledger. Credits are RESERVED when a generation is
 * submitted, CAPTURED for each scene that succeeds, and RELEASED for anything
 * that fails or is cancelled. Every write carries an idempotency key so a
 * retried request or webhook can never double-apply.
 */
export type LedgerReason = "grant" | "reserve" | "capture" | "release";

export interface LedgerEntry {
  id: number;
  userId: string;
  generationId?: string;
  reason: LedgerReason;
  /** Credits moved by this entry (always positive; reason gives the direction). */
  amount: number;
  idempotencyKey: string;
  createdAt: Date;
}

export class InsufficientCreditsError extends Error {
  constructor(public readonly needed: number, public readonly available: number) {
    super(`Insufficient credits: need ${needed}, have ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

export interface Balance {
  available: number;
  held: number;
  spent: number;
}

export interface Ledger {
  grant(userId: string, amount: number, idempotencyKey: string): Promise<LedgerEntry>;
  reserve(userId: string, generationId: string, amount: number, idempotencyKey: string): Promise<LedgerEntry>;
  capture(generationId: string, amount: number, idempotencyKey: string): Promise<LedgerEntry>;
  release(generationId: string, amount: number, idempotencyKey: string): Promise<LedgerEntry>;
  balance(userId: string): Promise<Balance>;
  heldFor(generationId: string): Promise<number>;
  entries(userId: string): Promise<LedgerEntry[]>;
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new LedgerInvariantError(`amount must be a positive integer, got ${amount}`);
  }
}

/** In-memory implementation used by tests and local dev. Production uses Postgres with a UNIQUE(idempotency_key). */
export class InMemoryLedger implements Ledger {
  private rows: LedgerEntry[] = [];
  private byKey = new Map<string, LedgerEntry>();
  private nextId = 1;

  private append(e: Omit<LedgerEntry, "id" | "createdAt">): LedgerEntry {
    const existing = this.byKey.get(e.idempotencyKey);
    if (existing) return existing; // idempotent replay
    const row: LedgerEntry = { ...e, id: this.nextId++, createdAt: new Date() };
    this.rows.push(row);
    this.byKey.set(e.idempotencyKey, row);
    return row;
  }

  private userOf(generationId: string): string {
    const r = this.rows.find((x) => x.generationId === generationId && x.reason === "reserve");
    if (!r) throw new LedgerInvariantError(`no reservation for generation ${generationId}`);
    return r.userId;
  }

  async grant(userId: string, amount: number, idempotencyKey: string) {
    assertAmount(amount);
    return this.append({ userId, reason: "grant", amount, idempotencyKey });
  }

  async reserve(userId: string, generationId: string, amount: number, idempotencyKey: string) {
    assertAmount(amount);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return existing;
    const { available } = await this.balance(userId);
    if (amount > available) throw new InsufficientCreditsError(amount, available);
    return this.append({ userId, generationId, reason: "reserve", amount, idempotencyKey });
  }

  async capture(generationId: string, amount: number, idempotencyKey: string) {
    assertAmount(amount);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return existing;
    const userId = this.userOf(generationId);
    const held = await this.heldFor(generationId);
    if (amount > held) throw new LedgerInvariantError(`capture ${amount} exceeds held ${held} for ${generationId}`);
    return this.append({ userId, generationId, reason: "capture", amount, idempotencyKey });
  }

  async release(generationId: string, amount: number, idempotencyKey: string) {
    assertAmount(amount);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return existing;
    const userId = this.userOf(generationId);
    const held = await this.heldFor(generationId);
    if (amount > held) throw new LedgerInvariantError(`release ${amount} exceeds held ${held} for ${generationId}`);
    return this.append({ userId, generationId, reason: "release", amount, idempotencyKey });
  }

  async heldFor(generationId: string): Promise<number> {
    let held = 0;
    for (const r of this.rows) {
      if (r.generationId !== generationId) continue;
      if (r.reason === "reserve") held += r.amount;
      else if (r.reason === "capture" || r.reason === "release") held -= r.amount;
    }
    return held;
  }

  async balance(userId: string): Promise<Balance> {
    let granted = 0, reserved = 0, captured = 0, released = 0;
    for (const r of this.rows) {
      if (r.userId !== userId) continue;
      if (r.reason === "grant") granted += r.amount;
      else if (r.reason === "reserve") reserved += r.amount;
      else if (r.reason === "capture") captured += r.amount;
      else released += r.amount;
    }
    const held = reserved - captured - released;
    return { available: granted - reserved + released, held, spent: captured };
  }

  async entries(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
}
