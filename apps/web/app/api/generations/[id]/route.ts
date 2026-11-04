import { jobProgress } from "@clipnova/core";
import { ApiError, getService, identify, jsonError } from "@/lib/service";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const c = await identify(req, url.searchParams.get("plan") ?? undefined, url.searchParams.get("region") ?? undefined);
    const svc = getService();
    const gen = svc.deps.store.findById(id);
    if (!gen || gen.userId !== c.userId) throw new ApiError(404, "Video not found.", "NOT_FOUND");
    const job = svc.jobs.get(id);
    const balance = await svc.deps.ledger.balance(c.userId);
    const planScenes = gen.request.creativePlan.scenes;
    const scenes = planScenes.map((ps) => {
      const live = job?.scenes.find((s) => s.index === ps.index);
      const done = gen.scenes.find((s) => s.index === ps.index);
      const rate = svc.registry.get(done?.modelId ?? "")?.profile.creditsPerSecond
        ?? svc.registry.select({ mode: gen.request.mode, aspectRatio: gen.request.aspectRatio, region: gen.request.region, modelId: gen.request.modelId })[0]?.profile.creditsPerSecond ?? 0;
      return {
        index: ps.index, durationSeconds: ps.durationSeconds, action: ps.action,
        state: live?.state ?? "queued", progress: live?.progress ?? 0, attempt: live?.attempt ?? 0,
        modelId: live?.modelId ?? done?.modelId, modelName: svc.registry.get(live?.modelId ?? done?.modelId ?? "")?.profile.name,
        regenCredits: Math.ceil(rate * ps.durationSeconds), busy: !!done?.busy,
      };
    });
    return Response.json({
      id: gen.id, status: gen.status, stage: job?.stage ?? "checking", progress: job ? jobProgress(job) : 0, scenes,
      credits: { quoted: gen.creditsQuoted, charged: gen.creditsCharged, refunded: gen.creditsRefunded },
      quote: gen.quote, modelName: gen.quote?.lines[0]?.label,
      outputUri: gen.outputUri, error: gen.errorCode ? { code: gen.errorCode, reasons: gen.rejectionReasons ?? [] } : undefined,
      rating: svc.ratings.get(id), balance,
    });
  } catch (e) { return jsonError(e); }
}
