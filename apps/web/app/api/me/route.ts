import { getService, identify, jsonError } from "@/lib/service";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const c = await identify(req, url.searchParams.get("plan") ?? undefined, url.searchParams.get("region") ?? undefined);
    const eng = await getService();
    return Response.json({ plan: c.plan, balance: await eng.ledger.balance(c.userId), region: c.region, engine: eng.kind });
  } catch (e) { return jsonError(e); }
}
