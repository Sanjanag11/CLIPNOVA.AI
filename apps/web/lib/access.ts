/**
 * Access gate for test deployments. The app has no sign-in yet and every visitor can use the shared demo credits,
 * which on a live deployment means spending real GPU money. So: a shared access code in front of everything.
 *
 *  - CLIPNOVA_ACCESS_CODE set (>= 10 characters)  -> visitors must enter it once (a cookie remembers them)
 *  - not set, but a GPU worker is attached in production -> CLOSED: everything is refused, so an unprotected
 *    deployment can never be left open by accident
 *  - not set, no GPU worker / not production -> open (local development)
 */
export type GateMode = "open" | "code" | "closed";
export const COOKIE = "cn_access";
export const MIN_CODE_LENGTH = 10;

export interface GateConfig { mode: GateMode; code?: string }

export function gateConfig(env: Record<string, string | undefined> = process.env): GateConfig {
  const code = env.CLIPNOVA_ACCESS_CODE?.trim();
  if (code) return code.length >= MIN_CODE_LENGTH ? { mode: "code", code } : { mode: "closed" }; // a weak code is a misconfiguration
  if (env.NODE_ENV === "production" && env.CLIPNOVA_WORKER_URL?.trim()) return { mode: "closed" };
  return { mode: "open" };
}

/** What the cookie holds: a hash, so the code itself is never stored in the browser. */
export async function accessToken(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(`clipnova-access:${code}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Paths that must stay reachable so a visitor can enter the code. */
const OPEN_PATHS = [/^\/gate$/, /^\/api\/gate$/];

export type Decision = "allow" | "gate" | "deny";

export function decide(cfg: GateConfig, pathname: string, cookieValue: string | undefined, expectedToken: string | undefined): Decision {
  if (cfg.mode === "open") return "allow";
  if (cfg.mode === "closed") return "deny";
  if (OPEN_PATHS.some((p) => p.test(pathname))) return "allow";
  if (cookieValue && expectedToken && constantTimeEqual(cookieValue, expectedToken)) return "allow";
  return "gate";
}
