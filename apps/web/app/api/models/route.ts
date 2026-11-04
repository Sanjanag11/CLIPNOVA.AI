import { AspectRatioSchema, ModeSchema } from "@clipnova/core";
import { identify, jsonError, modelAvailability } from "@/lib/service";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const c = await identify(req, url.searchParams.get("plan") ?? undefined, url.searchParams.get("region") ?? undefined);
    const mode = ModeSchema.parse(url.searchParams.get("mode") ?? "t2v");
    const aspect = AspectRatioSchema.parse(url.searchParams.get("aspect") ?? "9:16");
    return Response.json({ region: c.region, models: modelAvailability(mode, aspect, c.region) });
  } catch (e) { return jsonError(e); }
}
