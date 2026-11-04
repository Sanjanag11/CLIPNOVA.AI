import { DEFAULT_PLANS, runGeneration, type Addons, type AspectRatio, type Mode } from "@clipnova/core";
import { NextResponse } from "next/server";
import { getService, placeholderPlan, regionFrom } from "@/lib/service";

interface GenBody {
  planId: string; mode: Mode; durationSeconds: number; aspectRatio: AspectRatio; modelId?: string;
  addons: Addons; description: string; prompt: string; language: string; idempotencyKey: string; region?: string;
}

export async function POST(req: Request) {
  const b = (await req.json()) as GenBody;
  const plan = DEFAULT_PLANS.find((p) => p.id === b.planId);
  if (!plan) return NextResponse.json({ error: "unknown plan" }, { status: 400 });
  if (!b.description?.trim() || !b.prompt?.trim()) return NextResponse.json({ error: "description and prompt are required" }, { status: 400 });
  const svc = getService();
  const userId = `demo-${plan.id}`;
  // Demo only: each demo plan's user gets the plan's monthly credits once.
  await svc.deps.ledger.grant(userId, plan.monthlyCredits, `grant:${userId}`);
  const generation = await runGeneration(svc.deps, {
    userId, plan, idempotencyKey: `${userId}:${b.idempotencyKey}`, mode: b.mode, durationSeconds: b.durationSeconds,
    aspectRatio: b.aspectRatio, region: regionFrom(req, b.region), modelId: b.modelId, addons: b.addons,
    creativePlan: placeholderPlan({ description: b.description, prompt: b.prompt, durationSeconds: b.durationSeconds, language: b.language }),
  });
  const balance = await svc.deps.ledger.balance(userId);
  return NextResponse.json({ generation, balance });
}
