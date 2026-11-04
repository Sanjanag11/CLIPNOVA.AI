import { FakeAdapter, fakeProfile, type FakeBehavior } from "../src/adapters/fake.js";
import { InMemoryLedger } from "../src/ledger.js";
import { ModelRegistry } from "../src/models.js";
import { DEFAULT_PLANS, DEFAULT_PRICING } from "../src/plans.js";
import { InMemoryGenerationStore, type GenerationRequest, type WorkflowDeps, type WorkflowEvent } from "../src/workflow.js";
import { splitDuration } from "../src/scenes.js";
import type { CreativePlan, Duration } from "../src/plan.js";

export function makePlan(duration: number, maxClip = 5, description = "A cat learns to skateboard"): CreativePlan {
  const durations = splitDuration(duration, maxClip);
  return {
    schemaVersion: 1,
    rawInput: { description, creativePrompt: "funny, bright, handheld" },
    inputLanguage: "en",
    intent: { logline: "Cat skateboards", category: "comedy" },
    characters: [{ id: "c1", name: "Momo", appearance: "orange tabby cat", referenceAssetIds: [] }],
    setting: { visualStyle: "bright cartoon" },
    scenes: durations.map((d, i) => ({ index: i, durationSeconds: d, action: `Momo scene ${i}`, characterIds: ["c1"], sfx: [], sourcePhrases: [] })),
    audio: { narrationLanguage: "en", captionLanguage: "en" },
    safety: { flags: [] },
  };
}

export function setup(opts: { behavior?: FakeBehavior; extraAdapters?: FakeAdapter[]; blocked?: string[] } = {}) {
  const adapter = new FakeAdapter(fakeProfile(), opts.behavior);
  const registry = new ModelRegistry();
  registry.register(adapter);
  for (const a of opts.extraAdapters ?? []) registry.register(a);
  const ledger = new InMemoryLedger();
  const events: WorkflowEvent[] = [];
  let n = 0;
  const composeCalls: number[] = [];
  const deps: WorkflowDeps = {
    ledger, registry, store: new InMemoryGenerationStore(),
    moderator: { checkText: async (t) => (opts.blocked ?? []).filter((w) => t.includes(w)) },
    composer: { compose: async (id, scenes) => { composeCalls.push(scenes.length); return `fake://${id}/final.mp4`; } },
    pricing: DEFAULT_PRICING,
    newId: () => `gen_${++n}`,
    emit: (e) => events.push(e),
  };
  const req = (over: Partial<GenerationRequest> & { duration?: Duration } = {}): GenerationRequest => {
    const duration = over.duration ?? 8;
    return {
      userId: "u1", plan: DEFAULT_PLANS[1]!, idempotencyKey: `k${++n}`, mode: "t2v",
      durationSeconds: duration, aspectRatio: "9:16", tier: "standard",
      creativePlan: makePlan(duration), ...over,
    };
  };
  return { adapter, registry, ledger, deps, events, req, composeCalls };
}
