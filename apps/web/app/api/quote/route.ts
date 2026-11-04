import { checkPlanAllows, quoteCredits } from "@clipnova/core";
import { ApiError, effectiveAddons, getService, identify, jsonError } from "@/lib/service";
import { QuoteBody } from "@/lib/schemas";

export async function POST(req: Request) {
  try {
    const parsed = QuoteBody.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Invalid request.", "BAD_REQUEST");
    const b = parsed.data;
    const c = await identify(req, b.plan, b.region);
    const svc = getService();
    const models = svc.registry.select({ mode: b.mode, aspectRatio: b.aspectRatio, region: c.region, bucket: c.bucket, modelId: b.modelId, maxSceneSeconds: 5 });
    const balance = await svc.deps.ledger.balance(c.userId);
    const issues = checkPlanAllows(c.plan, b.mode, b.durationSeconds);
    const primary = models[0]?.profile;
    if (!primary) return Response.json({ error: "No model is available for this mode, shape and region.", code: "NO_MODEL", issues, balance, region: c.region });
    const quote = quoteCredits(svc.deps.pricing, primary.name, primary.creditsPerSecond, b.durationSeconds, effectiveAddons(svc, b.addons));
    return Response.json({ quote, modelUsed: primary.name, audioAvailable: svc.engine === "simulated", issues, balance, canAfford: quote.total <= balance.available, region: c.region });
  } catch (e) { return jsonError(e); }
}
