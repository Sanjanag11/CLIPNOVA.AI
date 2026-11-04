import { CreativePlanSchema, runGeneration } from "@clipnova/core";
import { ApiError, getService, identify, jsonError } from "@/lib/service";
import { GenerateBody } from "@/lib/schemas";

export async function POST(req: Request) {
  try {
    const parsed = GenerateBody.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Invalid request.", "BAD_REQUEST");
    const b = parsed.data;
    const plan = CreativePlanSchema.safeParse(b.creativePlan);
    if (!plan.success) throw new ApiError(400, "The scene plan is invalid.", "BAD_PLAN");
    const c = await identify(req, b.plan, b.region);
    const svc = getService();
    const key = `${c.userId}:${b.idempotencyKey}`;

    // Start the job and return immediately; the client polls GET /api/generations/:id.
    // (A durable queue replaces this in-process background run in production.)
    const run = runGeneration(svc.deps, {
      userId: c.userId, plan: c.plan, idempotencyKey: key, mode: b.mode, durationSeconds: b.durationSeconds,
      aspectRatio: b.aspectRatio, region: c.region, modelId: b.modelId, addons: b.addons,
      creativePlan: plan.data, rolloutBucket: c.bucket,
    });
    run.catch((e) => console.error("generation failed", e));
    // runGeneration registers the job synchronously, before its first await.
    const gen = svc.deps.store.findByIdempotencyKey(key);
    if (!gen) throw new ApiError(500, "Could not start the video.", "INTERNAL");
    return Response.json({ id: gen.id, status: gen.status }, { status: 202 });
  } catch (e) { return jsonError(e); }
}
