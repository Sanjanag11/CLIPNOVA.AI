import { describe, expect, it } from "vitest";
import { InsufficientCreditsError } from "@clipnova/core";
import { openEmbeddedDb } from "../lib/db";
import { SqlLedger } from "../lib/db/sql-ledger";
import { ledgerContract } from "../../../packages/core/test/ledger-contract";

// The SQL ledger must satisfy exactly the same rules as the in-memory one...
ledgerContract("credit ledger (Postgres)", async () => new SqlLedger(await openEmbeddedDb()));

// ...plus the things only a shared database can get wrong.
describe("SQL ledger under concurrency", () => {
  it("two simultaneous reservations can never spend the same credits", async () => {
    const l = new SqlLedger(await openEmbeddedDb());
    await l.grant("u", 100, "g");
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => l.reserve("u", `gen${i}`, 40, `r${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2); // 100 credits fit two 40s
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.every((r) => r.reason instanceof InsufficientCreditsError)).toBe(true);
    expect(await l.balance("u")).toEqual({ available: 20, held: 80, spent: 0 });
  });

  it("a replayed request returns the original entry even when sent in parallel", async () => {
    const l = new SqlLedger(await openEmbeddedDb());
    await l.grant("u", 50, "g");
    const all = await Promise.all(Array.from({ length: 5 }, () => l.reserve("u", "gen1", 30, "same-key")));
    expect(new Set(all.map((e) => e.id)).size).toBe(1);
    expect((await l.balance("u")).held).toBe(30);
    await Promise.all(Array.from({ length: 5 }, () => l.capture("gen1", 10, "cap-key")));
    expect(await l.balance("u")).toEqual({ available: 20, held: 20, spent: 10 });
  });

  it("entries are append-only and ordered", async () => {
    const l = new SqlLedger(await openEmbeddedDb());
    await l.grant("u", 10, "a"); await l.reserve("u", "g1", 4, "b"); await l.release("g1", 4, "c");
    expect((await l.entries("u")).map((e) => e.reason)).toEqual(["grant", "reserve", "release"]);
    expect(await l.balance("someone-else")).toEqual({ available: 0, held: 0, spent: 0 });
  });
});
