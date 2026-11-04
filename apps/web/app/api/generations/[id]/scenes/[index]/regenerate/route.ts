import { RegenError, regenerateScene } from "@clipnova/core";
import { ApiError, getService, identify, jsonError } from "@/lib/service";
import { RegenBody } from "@/lib/schemas";

const STATUS: Record<string, number> = { NOT_FOUND: 404, BAD_SCENE: 404, NOT_FINISHED: 409, SCENE_BUSY: 409, INSUFFICIENT_CREDITS: 402, NO_MODEL: 409 };

export async function POST(req: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await ctx.params;
    const parsed = RegenBody.safeParse(await req.json());
    if (!parsed.success || !/^\d+$/.test(index)) throw new ApiError(400, "Invalid request.", "BAD_REQUEST");
    const c = await identify(req, parsed.data.plan, parsed.data.region);
    const svc = getService();
    const gen = svc.deps.store.findById(id);
    if (!gen || gen.userId !== c.userId) throw new ApiError(404, "Video not found.", "NOT_FOUND");
    try {
      const r = await regenerateScene(svc.deps, id, Number(index), `${c.userId}:${parsed.data.idempotencyKey}`);
      return Response.json({ ok: r.ok, creditsCharged: r.creditsCharged, errorCode: r.errorCode, balance: await svc.deps.ledger.balance(c.userId) });
    } catch (e) {
      if (e instanceof RegenError) throw new ApiError(STATUS[e.code] ?? 400, e.message, e.code);
      throw e;
    }
  } catch (e) { return jsonError(e); }
}
