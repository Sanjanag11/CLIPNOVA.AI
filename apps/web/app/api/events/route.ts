import { CLIENT_EVENTS, cleanProps, recordEvent } from "@/lib/analytics";
import { getDb } from "@/lib/db";
import { assign } from "@/lib/experiments";
import { ApiError, jsonError } from "@/lib/service";

/** Browser-reported events. The tester's id and A/B variants are stamped HERE from the request, never trusted from the body. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { name?: unknown; props?: unknown } | null;
    if (!body || typeof body.name !== "string" || !CLIENT_EVENTS.has(body.name)) throw new ApiError(400, "Unknown event.", "BAD_EVENT");
    const props = cleanProps(body.props);
    if (!props) throw new ApiError(400, "Event properties must be a small flat object.", "BAD_PROPS");
    const raw = req.headers.get("x-cn-uid");
    const uid = raw && /^[a-f0-9]{32}$/.test(raw) ? raw : undefined;
    await recordEvent(await getDb(), { uid, name: body.name, props, variants: uid ? assign(uid) : {} });
    return Response.json({ ok: true }, { status: 202 });
  } catch (e) { return jsonError(e); }
}
