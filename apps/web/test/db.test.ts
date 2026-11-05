import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openEmbeddedDb } from "../lib/db";
import { SqlLedger } from "../lib/db/sql-ledger";

const dir = mkdtempSync(join(tmpdir(), "clipnova-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("embedded database (local development)", () => {
  it("creates its folder on a first run and keeps data across restarts", async () => {
    const path = join(dir, "does", "not", "exist", "yet", "pglite");
    const first = new SqlLedger(await openEmbeddedDb(path));
    await first.grant("u", 100, "g");
    await first.reserve("u", "gen1", 30, "r");
    const second = new SqlLedger(await openEmbeddedDb(path)); // a "restart": a second handle on the same files
    expect(await second.balance("u")).toEqual({ available: 70, held: 30, spent: 0 });
  }, 60_000);

  it("setting up the schema twice is harmless", async () => {
    const path = join(dir, "again");
    await openEmbeddedDb(path);
    const again = new SqlLedger(await openEmbeddedDb(path));
    await again.grant("u", 5, "x");
    expect((await again.balance("u")).available).toBe(5);
  }, 60_000);
});
