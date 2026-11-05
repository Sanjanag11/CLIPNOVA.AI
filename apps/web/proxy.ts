import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, accessToken, decide, gateConfig } from "./lib/access";

/** Runs before every request (Next 16's replacement for middleware). See lib/access.ts. */
export async function proxy(req: NextRequest) {
  const cfg = gateConfig();
  const expected = cfg.mode === "code" ? await accessToken(cfg.code!) : undefined;
  const d = decide(cfg, req.nextUrl.pathname, req.cookies.get(COOKIE)?.value, expected);
  if (d === "allow") return NextResponse.next();
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|prototype/).*)"],
};
