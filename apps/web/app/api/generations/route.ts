import { CreativePlanSchema } from "@clipnova/core";
import { ApiError, effectiveAddons, getService, identify, jsonError } from "@/lib/service";
import { GenerateBody } from "@/lib/schemas";

export async function POST(req: Request) {
  try {
    const parsed = GenerateBody.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Invalid request.", "BAD_REQUEST");
    const b = parsed.data;
    const plan = CreativePlanSchema.safeParse(b.creativePlan);
    if (!plan.success) throw new ApiError(400, "The scene plan is invalid.", "BAD_PLAN");
    const c = await identify(req, b.plan, b.region);
    const eng = await getService();
    // Returns quickly: the video renders on the engine and the client polls GET /api/generations/:id.
    const { id, status } = await eng.start(c, {
      idempotencyKey: b.idempotencyKey, mode: b.mode, durationSeconds: b.durationSeconds, aspectRatio: b.aspectRatio,
      modelId: b.modelId, addons: effectiveAddons(eng, b.addons), creativePlan: plan.data,
    });
    return Response.json({ id, status }, { status: 202 });
  } catch (e) { return jsonError(e); }
}
