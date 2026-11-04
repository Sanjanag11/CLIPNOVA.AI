import { describe, expect, it } from "vitest";
import { FakeAdapter, fakeProfile } from "../src/adapters/fake";
import { ModelRegistry } from "../src/models";
import { DEFAULT_PRICING, quoteCredits } from "../src/plans";
import { isRegionExcluded } from "../src/regions";
import { runGeneration } from "../src/workflow";
import { setup } from "./helpers";

const adapter = (id: string, over = {}) => new FakeAdapter(fakeProfile({ id, name: id, ...over }));

describe("pricing mirrors the prototype", () => {
  it("8s on Wan (6 cr/s) with voice, music and sfx = 53 credits", () => {
    const q = quoteCredits(DEFAULT_PRICING, "Wan 2.2", 6, 8, { voice: true, music: true, sfx: true });
    expect(q.total).toBe(48 + 2 + 2 + 1);
    expect(q.lines.map((l) => l.label)).toEqual(["Video · Wan 2.2 · 8s", "Voiceover", "Music", "Sound effects"]);
  });
  it("voiceover is 1 credit per 4 seconds, rounded up; captions are free", () => {
    const only = (d: number) => quoteCredits(DEFAULT_PRICING, "m", 0, d, { voice: true, music: false, sfx: false }).total;
    expect([only(4), only(6), only(8), only(12), only(30)]).toEqual([1, 2, 2, 3, 8]);
  });
  it("add-ons off means video credits only", () => {
    expect(quoteCredits(DEFAULT_PRICING, "LTX-Video", 3, 6, { voice: false, music: false, sfx: false }).total).toBe(18);
  });
});

describe("regions and licences", () => {
  it("expands the EU group and matches single countries", () => {
    expect(isRegionExcluded("DE", ["EU", "GB", "KR"])).toBe(true);
    expect(isRegionExcluded("gb", ["EU", "GB", "KR"])).toBe(true);
    expect(isRegionExcluded("KR", ["EU", "GB", "KR"])).toBe(true);
    expect(isRegionExcluded("IN", ["EU", "GB", "KR"])).toBe(false);
    expect(isRegionExcluded("US", ["EU", "GB", "KR"])).toBe(false);
  });

  const hunyuanLike = () => adapter("hunyuan", { licence: { id: "tencent-community", commercialUse: true, excludedTerritories: ["EU", "GB", "KR"] } });

  it("a territory-restricted model is used in India and never in the EU, UK or Korea", () => {
    const reg = new ModelRegistry();
    reg.register(hunyuanLike());
    const q = { mode: "t2v" as const, aspectRatio: "9:16" as const };
    expect(reg.select({ ...q, region: "IN" }).map((a) => a.profile.id)).toEqual(["hunyuan"]);
    for (const region of ["DE", "FR", "GB", "KR"]) expect(reg.select({ ...q, region })).toEqual([]);
  });

  it("an EU user is routed to another model; with no alternative the request is rejected before any charge", async () => {
    const t = setup({ extraAdapters: [hunyuanLike()] });
    t.registry.setEnabled("fake-standard", false);
    await t.ledger.grant("u1", 100, "grant");
    const india = await runGeneration(t.deps, t.req({ duration: 4, region: "IN" }));
    expect(india.scenes[0]!.modelId).toBe("hunyuan");
    const eu = await runGeneration(t.deps, t.req({ duration: 4, region: "DE" }));
    expect(eu.status).toBe("rejected");
    expect(eu.errorCode).toBe("NO_MODEL");
    expect((await t.ledger.balance("u1")).held).toBe(0);
  });
});

describe("model selection", () => {
  const q = { mode: "t2v" as const, aspectRatio: "9:16" as const, region: "IN" };

  it("Auto follows the preferred order, then cheapest first", () => {
    const reg = new ModelRegistry();
    reg.register(adapter("ltx", { creditsPerSecond: 3 }));
    reg.register(adapter("wan", { creditsPerSecond: 6 }));
    reg.register(adapter("cog", { creditsPerSecond: 4 }));
    reg.autoOrder = { t2v: ["wan"] };
    expect(reg.select(q).map((a) => a.profile.id)).toEqual(["wan", "ltx", "cog"]);
  });

  it("a user-chosen model is returned alone and never silently swapped", () => {
    const reg = new ModelRegistry();
    reg.register(adapter("ltx"));
    reg.register(adapter("wan"));
    expect(reg.select({ ...q, modelId: "ltx" }).map((a) => a.profile.id)).toEqual(["ltx"]);
    expect(reg.select({ ...q, modelId: "auto" })).toHaveLength(2);
    expect(reg.select({ ...q, modelId: "missing" })).toEqual([]);
  });

  it("skips models that don't support the mode, aspect ratio or scene length", () => {
    const reg = new ModelRegistry();
    reg.register(adapter("svd", { modes: ["i2v"] }));
    reg.register(adapter("short", { maxClipSeconds: 3 }));
    reg.register(adapter("no45", { aspectRatios: ["16:9"] }));
    expect(reg.select(q).map((a) => a.profile.id)).toEqual(["short"]);
    expect(reg.select({ ...q, maxSceneSeconds: 5 })).toEqual([]);
    expect(reg.select({ ...q, mode: "i2v" }).map((a) => a.profile.id)).toContain("svd");
  });

  it("supports the 4:5 feed ratio end to end", async () => {
    const t = setup();
    t.registry.setEnabled("fake-standard", false);
    t.registry.register(adapter("p45", { aspectRatios: ["4:5"] }));
    await t.ledger.grant("u1", 100, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 4, aspectRatio: "4:5" }));
    expect(g.status).toBe("succeeded");
  });

  it("quotes on the chosen model's rate and exposes line items", async () => {
    const t = setup({ extraAdapters: [adapter("pricey", { creditsPerSecond: 7, name: "Pricey" })] });
    await t.ledger.grant("u1", 200, "grant");
    const g = await runGeneration(t.deps, t.req({ duration: 8, modelId: "pricey", addons: { voice: true, music: true, sfx: true } }));
    expect(g.quote!.lines[0]).toEqual({ label: "Video · Pricey · 8s", credits: 56 });
    expect(g.creditsQuoted).toBe(56 + 2 + 2 + 1);
    expect(g.status).toBe("succeeded");
    expect((await t.ledger.balance("u1")).spent).toBe(61);
  });
});
