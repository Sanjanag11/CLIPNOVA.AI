import { ApiError, getService, identify, jsonError } from "@/lib/service";
import { RatingBody } from "@/lib/schemas";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const parsed = RatingBody.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Invalid request.", "BAD_REQUEST");
    const c = await identify(req, parsed.data.plan, parsed.data.region);
    if (!(await (await getService()).rate(c, id, parsed.data.value))) throw new ApiError(404, "Video not found.", "NOT_FOUND");
    return Response.json({ ok: true });
  } catch (e) { return jsonError(e); }
}
