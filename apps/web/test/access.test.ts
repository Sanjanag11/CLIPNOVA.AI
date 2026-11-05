import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { COOKIE, accessToken, constantTimeEqual, decide, gateConfig } from "../lib/access";
import { proxy } from "../proxy";

const CODE = "correct-horse-battery";

describe("gate configuration (fails closed)", () => {
  it.each([
    [{ CLIPNOVA_ACCESS_CODE: CODE }, "code"],
    [{ CLIPNOVA_ACCESS_CODE: "short" }, "closed"],                                           // a weak code is a misconfiguration
    [{ NODE_ENV: "production", CLIPNOVA_WORKER_URL: "https://gpu.example" }, "closed"],       // GPU attached, no code: refuse everyone
    [{ NODE_ENV: "production", CLIPNOVA_WORKER_URL: "https://gpu.example", CLIPNOVA_ACCESS_CODE: CODE }, "code"],
    [{ NODE_ENV: "development", CLIPNOVA_WORKER_URL: "http://localhost:8000" }, "open"],
    [{ NODE_ENV: "production" }, "open"],                                                    // nothing expensive attached
    [{}, "open"],
  ])("%j -> %s", (env, mode) => expect(gateConfig(env).mode).toBe(mode));
});

describe("decisions", () => {
  const cfg = { mode: "code" as const, code: CODE };
  it("lets people reach the gate page, and everything else only with the right cookie", async () => {
    const token = await accessToken(CODE);
    expect(decide(cfg, "/gate", undefined, token)).toBe("allow");
    expect(decide(cfg, "/api/gate", undefined, token)).toBe("allow");
    expect(decide(cfg, "/create", undefined, token)).toBe("gate");
    expect(decide(cfg, "/api/generations", "wrong", token)).toBe("gate");
    expect(decide(cfg, "/create", token, token)).toBe("allow");
    expect(decide(cfg, "/gate/../create", undefined, token)).toBe("gate");                      // no path tricks
    expect(decide({ mode: "closed" }, "/gate", token, token)).toBe("deny");
    expect(decide({ mode: "open" }, "/create", undefined, undefined)).toBe("allow");
  });
  it("the cookie holds a hash, never the code", async () => {
    const t = await accessToken(CODE);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(t).not.toContain(CODE);
    expect(await accessToken(CODE)).toBe(t);
    expect(await accessToken("other-code-value")).not.toBe(t);
  });
  it("compares in constant time shape", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("the proxy and the gate endpoint", () => {
  const saved = { ...process.env };
  afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  const env = process.env as Record<string, string | undefined>;

  it("redirects pages to the gate, answers APIs with 401, and refuses everything when closed", async () => {
    env.CLIPNOVA_ACCESS_CODE = CODE;
    const page = await proxy(new NextRequest("http://x/create?plan=pro"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location")!).pathname).toBe("/gate");
    expect(decodeURIComponent(new URL(page.headers.get("location")!).searchParams.get("next")!)).toBe("/create?plan=pro");
    const api = await proxy(new NextRequest("http://x/api/generations", { method: "POST" }));
    expect(api.status).toBe(401);
    expect((await api.json()).code).toBe("ACCESS_REQUIRED");
    delete env.CLIPNOVA_ACCESS_CODE; env.NODE_ENV = "production"; env.CLIPNOVA_WORKER_URL = "https://gpu.example";
    expect((await proxy(new NextRequest("http://x/create"))).status).toBe(503);
    expect((await proxy(new NextRequest("http://x/api/me"))).status).toBe(503);
  });

  it("entering the right code sets a cookie that opens the door; a wrong code does not", async () => {
    env.CLIPNOVA_ACCESS_CODE = CODE;
    const { POST } = await import("../app/api/gate/route");
    const bad = await POST(new Request("http://x/api/gate", { method: "POST", body: JSON.stringify({ code: "nope-nope-nope" }) }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const good = await POST(new Request("http://x/api/gate", { method: "POST", body: JSON.stringify({ code: ` ${CODE} ` }) }));
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie")!;
    expect(cookie).toContain(`${COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).not.toContain(CODE);
    const value = cookie.match(new RegExp(`${COOKIE}=([0-9a-f]+)`))![1]!;
    const through = await proxy(new NextRequest("http://x/create", { headers: { cookie: `${COOKIE}=${value}` } }));
    expect(through.headers.get("x-middleware-next")).toBe("1");                                  // allowed through
  }, 20_000);

  it("is a no-op when no code is configured and nothing expensive is attached", async () => {
    delete env.CLIPNOVA_ACCESS_CODE; delete env.CLIPNOVA_WORKER_URL;
    expect((await proxy(new NextRequest("http://x/create"))).headers.get("x-middleware-next")).toBe("1");
  });
});
