import { NextResponse } from "next/server";
import { COOKIE, accessToken, constantTimeEqual, gateConfig } from "@/lib/access";

export async function POST(req: Request) {
  const cfg = gateConfig();
  if (cfg.mode !== "code") return NextResponse.json({ error: "No access code is set up.", code: "ACCESS_NOT_CONFIGURED" }, { status: cfg.mode === "open" ? 200 : 503 });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const given = typeof body.code === "string" ? body.code.trim() : "";
  if (!constantTimeEqual(await accessToken(given), await accessToken(cfg.code!))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return NextResponse.json({ error: "That code isn't right.", code: "BAD_CODE" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await accessToken(cfg.code!), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 7 * 24 * 3600 });
  return res;
}
