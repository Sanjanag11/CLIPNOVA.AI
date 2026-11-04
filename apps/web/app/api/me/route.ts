import { getService, identify, jsonError } from "@/lib/service";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const c = await identify(req, url.searchParams.get("plan") ?? undefined, url.searchParams.get("region") ?? undefined);
    const balance = await getService().deps.ledger.balance(c.userId);
    return Response.json({ plan: c.plan, balance, region: c.region });
  } catch (e) { return jsonError(e); }
}
