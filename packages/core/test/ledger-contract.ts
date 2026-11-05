import { describe, expect, it } from "vitest";
import { InsufficientCreditsError, LedgerInvariantError, type Ledger } from "../src/ledger";

/** Every Ledger implementation (in-memory, SQL...) must pass exactly these rules. */
export function ledgerContract(name: string, make: () => Promise<Ledger> | Ledger) {
  describe(name, () => {

  it("grants and reserves", async () => {
    const l = await make();
    await l.grant("u", 100, "g1");
    await l.reserve("u", "gen1", 30, "r1");
    expect(await l.balance("u")).toEqual({ available: 70, held: 30, spent: 0 });
  });

  it("capture moves held to spent; release returns to available", async () => {
    const l = await make();
    await l.grant("u", 100, "g1");
    await l.reserve("u", "gen1", 30, "r1");
    await l.capture("gen1", 10, "c1");
    await l.release("gen1", 20, "x1");
    expect(await l.balance("u")).toEqual({ available: 90, held: 0, spent: 10 });
  });

  it("refuses to reserve more than available", async () => {
    const l = await make();
    await l.grant("u", 5, "g1");
    await expect(l.reserve("u", "gen1", 6, "r1")).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await l.balance("u")).toEqual({ available: 5, held: 0, spent: 0 });
  });

  it("is idempotent: replaying a key never double-applies", async () => {
    const l = await make();
    await l.grant("u", 50, "g1");
    await l.grant("u", 50, "g1");
    await l.reserve("u", "gen1", 20, "r1");
    await l.reserve("u", "gen1", 20, "r1");
    await l.release("gen1", 20, "x1");
    await l.release("gen1", 20, "x1");
    expect(await l.balance("u")).toEqual({ available: 50, held: 0, spent: 0 });
  });

  it("cannot capture or release more than is held", async () => {
    const l = await make();
    await l.grant("u", 50, "g1");
    await l.reserve("u", "gen1", 10, "r1");
    await expect(l.capture("gen1", 11, "c1")).rejects.toBeInstanceOf(LedgerInvariantError);
    await l.release("gen1", 10, "x1");
    await expect(l.release("gen1", 1, "x2")).rejects.toBeInstanceOf(LedgerInvariantError);
  });

  it("rejects non-positive or fractional amounts", async () => {
    const l = await make();
    await expect(l.grant("u", 0, "a")).rejects.toBeInstanceOf(LedgerInvariantError);
    await expect(l.grant("u", 1.5, "b")).rejects.toBeInstanceOf(LedgerInvariantError);
  });

  it("balance never goes negative across a random sequence of operations", async () => {
    const l = await make();
    await l.grant("u", 200, "g");
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i++) {
      const gen = `gen${i % 5}`;
      const amt = 1 + Math.floor(rnd() * 15);
      try {
        const op = Math.floor(rnd() * 3);
        if (op === 0) await l.reserve("u", gen, amt, `r${i}`);
        else if (op === 1) await l.capture(gen, amt, `c${i}`);
        else await l.release(gen, amt, `x${i}`);
      } catch { /* invalid ops are rejected, which is the point */ }
      const b = await l.balance("u");
      expect(b.available).toBeGreaterThanOrEqual(0);
      expect(b.held).toBeGreaterThanOrEqual(0);
      expect(b.available + b.held + b.spent).toBe(200);
    }
  });
  });
}
