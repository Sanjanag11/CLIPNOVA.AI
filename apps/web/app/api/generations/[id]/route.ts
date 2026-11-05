import { ApiError, getService, identify, jsonError } from "@/lib/service";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const c = await identify(req, url.searchParams.get("plan") ?? undefined, url.searchParams.get("region") ?? undefined);
    const view = await (await getService()).view(c, id);
    if (!view) throw new ApiError(404, "Video not found.", "NOT_FOUND");
    return Response.json(view);
  } catch (e) { return jsonError(e); }
}
