import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "clipnova-analytics-"));
process.env.CLIPNOVA_DATA_DIR = dir;
process.env.CLIPNOVA_DEMO = "1";
delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.CLIPNOVA_ACCESS_CODE; delete process.env.CLIPNOVA_WORKER_URL;

type Handler = (req: Request, ctx?: any) => Promise<Response>; // eslint-disable-line @typescript-eslint/no-explicit-any
let me: { GET: Handler }, events: { POST: Handler }, proxy: (r: NextRequest) => Promise<Response>;
let cleanProps: typeof import("../lib/analytics").cleanProps, assign: typeof import("../lib/experiments").assign, getDb: typeof import("../lib/db").getDb;

beforeAll(async () => {
  me = await import("../app/api/me/route"); events = await import("../app/api/events/route");
  ({ proxy } = await import("../proxy")); ({ cleanProps } = await import("../lib/analytics"));
  ({ assign } = await import("../lib/experiments")); ({ getDb } = await import("../lib/db"));
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hex = (c: string) => c.repeat(32);
const req = (url: string, headers: Record<string, string> = {}, init: RequestInit = {}) => new Request(`http://x${url}`, { headers, ...init });
const post = (body: unknown, headers: Record<string, string> = {}) => events.POST(req("/api/events", { "content-type": "application/json", ...headers }, { method: "POST", body: JSON.stringify(body) }));
const balance = async (uid: string | null, plan = "free") => (await (await me.GET(req(`/api/me?plan=${plan}`, uid ? { "x-cn-uid": uid } : {}))).json()).balance;

describe("each tester gets an anonymous id (proxy)", () => {
  const forwarded = (res: Response) => res.headers.get("x-middleware-request-x-cn-uid");
  const setCookie = (res: Response) => res.headers.get("set-cookie") ?? "";

  it("a new browser gets a cookie and the API sees the same id", async () => {
    const res = await proxy(new NextRequest("http://x/create"));
    const uid = forwarded(res)!;
    expect(uid).toMatch(/^[a-f0-9]{32}$/);
    expect(setCookie(res)).toContain(`cn_uid=${uid}`);
    expect(setCookie(res).toLowerCase()).toContain("httponly");
  });

  it("a returning browser keeps its id and gets no new cookie", async () => {
    const uid = hex("a");
    const res = await proxy(new NextRequest("http://x/create", { headers: { cookie: `cn_uid=${uid}` } }));
    expect(forwarded(res)).toBe(uid);
    expect(setCookie(res)).not.toContain("cn_uid=");
  });

  it("a tester cannot pose as someone else by sending the header, and a bad cookie is replaced", async () => {
    const spoof = await proxy(new NextRequest("http://x/api/me", { headers: { "x-cn-uid": hex("b") } }));
    expect(forwarded(spoof)).not.toBe(hex("b"));
    const bad = await proxy(new NextRequest("http://x/api/me", { headers: { cookie: "cn_uid=not-valid", "x-cn-uid": hex("c") } }));
    expect(forwarded(bad)).toMatch(/^[a-f0-9]{32}$/);
    expect(forwarded(bad)).not.toBe(hex("c"));
    expect(setCookie(bad)).toContain("cn_uid=");
  });
});

describe("separate wallets and variants per tester", () => {
  it("testers do not share credits; the same tester always sees the same wallet and variants", async () => {
    const [a, b] = [hex("1"), hex("2")];
    expect((await balance(a)).available).toBe(120);
    expect((await balance(b)).available).toBe(120);
    const first = await (await me.GET(req("/api/me?plan=free", { "x-cn-uid": a }))).json();
    const again = await (await me.GET(req("/api/me?plan=free", { "x-cn-uid": a }))).json();
    expect(first.variants).toEqual(assign(a));
    expect(again.variants).toEqual(first.variants);
    expect(Object.keys(first.variants).sort()).toEqual(["default_length", "prompt_boost", "savings_hint"]);
  });

  it("without an id (local tests) everyone shares the plan's demo wallet and has no variants", async () => {
    const r = await (await me.GET(req("/api/me?plan=free"))).json();
    expect(r.variants).toEqual({});
  });

  it("a malformed id header is ignored, never used as an account name", async () => {
    const r = await (await me.GET(req("/api/me?plan=free", { "x-cn-uid": "../../etc/passwd" }))).json();
    expect(r.variants).toEqual({});
  });

  it("each plan is its own wallet for the same tester", async () => {
    const u = hex("3");
    await balance(u, "free");
    expect((await balance(u, "pro")).available).toBe(2500);
    expect((await balance(u, "free")).available).toBe(120);
  });
});

describe("the events endpoint", () => {
  const rows = async (name: string) => (await (await getDb()).query<{ uid: string | null; props: Record<string, unknown>; variants: Record<string, string> }>("SELECT uid, props, variants FROM events WHERE name = $1 ORDER BY id", [name]));

  it("records an event stamped with the tester's id and variants", async () => {
    const uid = hex("4");
    const r = await post({ name: "plan_requested", props: { mode: "t2v", seconds: 8, boosted: true } }, { "x-cn-uid": uid });
    expect(r.status).toBe(202);
    const [row] = (await rows("plan_requested")).slice(-1);
    expect(row).toMatchObject({ uid, props: { mode: "t2v", seconds: 8, boosted: true }, variants: assign(uid) });
  });

  it("ignores variants or ids sent in the body (they come from the server)", async () => {
    const uid = hex("5");
    await post({ name: "create_view", props: {}, variants: { prompt_boost: "boost" }, uid: hex("9") }, { "x-cn-uid": uid });
    const [row] = (await rows("create_view")).slice(-1);
    expect(row!.uid).toBe(uid);
    expect(row!.variants).toEqual(assign(uid));
  });

  it("works without an id too (stored with no tester)", async () => {
    await post({ name: "page_view", props: { page: "landing" } });
    expect((await rows("page_view")).some((r) => r.uid === null)).toBe(true);
  });

  it.each([
    ["an unknown event", { name: "drop_table" }],
    ["a server-only event", { name: "generation_finished", props: { status: "succeeded" } }],
    ["no name", { props: {} }],
    ["a nested property", { name: "page_view", props: { a: { b: 1 } } }],
    ["a list property", { name: "page_view", props: { a: [1] } }],
    ["too many properties", { name: "page_view", props: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 1])) }],
    ["a very long value", { name: "page_view", props: { a: "x".repeat(201) } }],
    ["a badly named property", { name: "page_view", props: { "Bad Key": 1 } }],
    ["a non-finite number", { name: "page_view", props: { a: null } }],
  ])("refuses %s", async (_n, body) => {
    const before = (await (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM events"))[0]!.n;
    const r = await post(body);
    expect(r.status).toBe(400);
    expect((await (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM events"))[0]!.n).toBe(before);
  });

  it("refuses a body that isn't JSON", async () => {
    expect((await events.POST(req("/api/events", {}, { method: "POST", body: "not json" }))).status).toBe(400);
  });

  it("property cleaning keeps good values untouched", () => {
    expect(cleanProps(undefined)).toEqual({});
    expect(cleanProps({ page: "create", n: 3, ok: true })).toEqual({ page: "create", n: 3, ok: true });
    expect(cleanProps([])).toBeNull();
    expect(cleanProps("x")).toBeNull();
  });
});
