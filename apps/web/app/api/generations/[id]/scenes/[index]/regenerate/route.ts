import { ApiError, getService, identify, jsonError } from "@/lib/service";
import { RegenBody } from "@/lib/schemas";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await ctx.params;
    const parsed = RegenBody.safeParse(await req.json());
    if (!parsed.success || !/^\d+$/.test(index)) throw new ApiError(400, "Invalid request.", "BAD_REQUEST");
    const c = await identify(req, parsed.data.plan, parsed.data.region);
    const eng = await getService();
    const r = await eng.regenerate(c, id, Number(index), parsed.data.idempotencyKey);
    return Response.json({ ...r, balance: await eng.ledger.balance(c.userId) });
  } catch (e) { return jsonError(e); }
}
