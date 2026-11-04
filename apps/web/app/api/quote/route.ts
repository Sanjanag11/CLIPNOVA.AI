import { DEFAULT_PLANS, checkPlanAllows, quoteCredits, type Addons, type AspectRatio, type Mode } from "@clipnova/core";
import { NextResponse } from "next/server";
import { getService, regionFrom } from "@/lib/service";

interface QuoteBody {
  planId: string; mode: Mode; durationSeconds: number; aspectRatio: AspectRatio;
  modelId?: string; addons: Addons; region?: string;
}

export async function POST(req: Request) {
  const b = (await req.json()) as QuoteBody;
  const plan = DEFAULT_PLANS.find((p) => p.id === b.planId);
  if (!plan) return NextResponse.json({ error: "unknown plan" }, { status: 400 });
  const region = regionFrom(req, b.region);
  const svc = getService();
  const models = svc.registry.select({ mode: b.mode, aspectRatio: b.aspectRatio, region, modelId: b.modelId, maxSceneSeconds: 5 });
  const issues = checkPlanAllows(plan, b.mode, b.durationSeconds);
  const primary = models[0]?.profile;
  if (!primary) return NextResponse.json({ error: "No model is available for this mode, ratio and region.", issues, region }, { status: 200 });
  const quote = quoteCredits(svc.deps.pricing, primary.name, primary.creditsPerSecond, b.durationSeconds, b.addons);
  return NextResponse.json({ quote, modelUsed: primary.name, issues, region });
}
