import { DEFAULT_PLANS, isRegionExcluded, type AspectRatio, type Mode } from "@clipnova/core";
import { UI_MODEL_IDS } from "./catalog";
import { ApiError } from "./errors";
import { SimEngine } from "./engines/sim";
import { buildLiveEngine, liveConfigFromEnv } from "./engines/live";
import type { Caller, Engine } from "./engines/types";

export { ApiError };
export type { Caller, Engine };

/**
 * The engine for this process. Without CLIPNOVA_WORKER_URL: the simulated engine (in memory, fake models, no video).
 * With it: the live engine (Postgres + the GPU worker), which keeps no state in memory and so works on Vercel.
 */
const g = globalThis as unknown as { __clipnova?: Promise<Engine> };

export function getService(): Promise<Engine> {
  g.__clipnova ??= (async () => {
    const live = liveConfigFromEnv();
    return live ? buildLiveEngine(live) : new SimEngine();
  })();
  g.__clipnova.catch(() => { g.__clipnova = undefined; }); // retry on the next request if setup failed
  return g.__clipnova;
}

/**
 * Voiceover, music and sound effects are only simulated today. The live engine produces no audio, so it must not
 * charge for it: add-ons are switched off there until audio generation exists.
 */
export function effectiveAddons(eng: Engine, requested: { voice: boolean; music: boolean; sfx: boolean }) {
  return eng.audio ? requested : { voice: false, music: false, sfx: false };
}

/** The demo has no sign-in yet, so the caller picks a demo plan. Disabled in production unless explicitly enabled. */
export function demoEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.CLIPNOVA_DEMO === "1";
}

const granted = new Set<string>();

export async function identify(req: Request, planId: string | undefined, regionOverride?: string): Promise<Caller> {
  if (!demoEnabled()) throw new ApiError(501, "Sign-in is not available yet.", "AUTH_NOT_CONFIGURED");
  const plan = DEFAULT_PLANS.find((p) => p.id === (planId ?? "free"));
  if (!plan) throw new ApiError(400, "Unknown plan.", "BAD_PLAN");
  const header = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry");
  const region = (regionOverride || header || "IN").toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new ApiError(400, "Region must be a 2-letter country code.", "BAD_REGION");
  const userId = `demo-${plan.id}`;
  const eng = await getService();
  await eng.refresh?.();
  // Each demo plan's user receives the plan's monthly credits once (the ledger ignores repeats of the same key).
  if (!granted.has(`${eng.kind}:${userId}`)) {
    await eng.ledger.grant(userId, plan.monthlyCredits, `grant:${userId}`);
    granted.add(`${eng.kind}:${userId}`);
  }
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) % 100;
  return { userId, plan, region, bucket: h };
}

export interface ModelAvailability { id: string; name: string; rate: number; modes: Mode[]; available: boolean; reason?: string }

export function modelAvailability(eng: Engine, mode: Mode, aspect: AspectRatio, region: string): ModelAvailability[] {
  const rows = new Map(eng.registry.list().map((r) => [r.adapter.profile.id, r]));
  return UI_MODEL_IDS.map((u) => {
    const row = rows.get(u.id);
    if (!row) return { id: u.id, name: u.name, rate: u.rate, modes: u.modes, available: false, reason: "Coming soon" };
    const p = row.adapter.profile;
    let reason: string | undefined;
    if (!row.enabled) reason = "Temporarily unavailable";
    else if (!p.modes.includes(mode)) reason = mode === "t2v" ? "Not available for this mode" : "Not available yet for this mode";
    else if (!p.aspectRatios.includes(aspect)) reason = "Doesn't support this shape";
    else if (isRegionExcluded(region, p.licence.excludedTerritories ?? [])) reason = "Not available in your region";
    return { id: p.id, name: p.name, rate: p.creditsPerSecond, modes: u.modes, available: !reason, reason };
  });
}

export function jsonError(e: unknown) {
  if (e instanceof ApiError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Something went wrong.", code: "INTERNAL" }, { status: 500 });
}
