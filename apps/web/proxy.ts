import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, accessToken, decide, gateConfig } from "./lib/access";

/** Runs before every request (Next 16's replacement for middleware). See lib/access.ts. */
export async function proxy(req: NextRequest) {
  const cfg = gateConfig();
  const expected = cfg.mode === "code" ? await accessToken(cfg.code!) : undefined;
  const d = decide(cfg, req.nextUrl.pathname, req.cookies.get(COOKIE)?.value, expected);
  if (d === "allow") return withTesterId(req);
  const isApi = req.nextUrl.pathname.startsWith("/api/");
  if (d === "deny") {
    const msg = "This deployment is not open yet: the access code has not been configured.";
    return isApi ? NextResponse.json({ error: msg, code: "ACCESS_NOT_CONFIGURED" }, { status: 503 }) : new NextResponse(msg, { status: 503 });
  }
  if (isApi) return NextResponse.json({ error: "Enter the access code first.", code: "ACCESS_REQUIRED" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

const UID_COOKIE = "cn_uid";

/**
 * Gives every browser a stable anonymous id (a cookie) and hands it to the API as a header. A client-sent copy of the
 * header is always overwritten, so a tester can't pose as someone else.
 */
function withTesterId(req: NextRequest) {
  const existing = req.cookies.get(UID_COOKIE)?.value;
  const uid = existing && /^[a-f0-9]{32}$/.test(existing) ? existing : crypto.randomUUID().replaceAll("-", "");
  const headers = new Headers(req.headers);
  headers.set("x-cn-uid", uid);
  const res = NextResponse.next({ request: { headers } });
  if (uid !== existing) res.cookies.set(UID_COOKIE, uid, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 24 * 3600 });
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|prototype/).*)"],
};
