/**
 * A/B experiments. Each tester gets ONE variant per experiment, assigned by hashing their anonymous id, so it is
 * stable across visits and needs no database. Every recorded event and every generation carries the assignments,
 * which is what lets Admin compare variants.
 *
 * To run a different test: edit EXPERIMENTS below (or limit which are live with CLIPNOVA_EXPERIMENTS=a,b), redeploy.
 */
export interface Variant { id: string; weight: number }
export interface Experiment { id: string; description: string; variants: Variant[] }

export const EXPERIMENTS: Experiment[] = [
  {
    id: "prompt_boost",
    description: "Does appending a quality phrase to every scene prompt get more thumbs-up? (control = prompt as written, boost = adds 'cinematic lighting, highly detailed, smooth natural motion, sharp focus')",
    variants: [{ id: "control", weight: 50 }, { id: "boost", weight: 50 }],
  },
  {
    id: "default_length",
    description: "Does a shorter default length (4 s) change how many testers finish a video, compared with 8 s?",
    variants: [{ id: "8s", weight: 50 }, { id: "4s", weight: 50 }],
  },
  {
    id: "savings_hint",
    description: "Does showing cheaper-model suggestions on the plan screen change how often testers generate?",
    variants: [{ id: "shown", weight: 50 }, { id: "hidden", weight: 50 }],
  },
];

export const BOOST_SUFFIX = "cinematic lighting, highly detailed, smooth natural motion, sharp focus";

/** 32-bit FNV-1a: small, fast, and spreads well enough for bucketing. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function liveExperiments(env: Record<string, string | undefined> = process.env, all: Experiment[] = EXPERIMENTS): Experiment[] {
  const only = env.CLIPNOVA_EXPERIMENTS?.split(",").map((x) => x.trim()).filter(Boolean);
  return only ? all.filter((e) => only.includes(e.id)) : all;
}

/** The variant of each live experiment for this tester. Deterministic: the same id always gets the same answer. */
export function assign(uid: string, exps: Experiment[] = liveExperiments()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of exps) {
    const total = e.variants.reduce((a, v) => a + v.weight, 0);
    if (total <= 0) continue;
    let pick = hash(`${uid}:${e.id}`) % total;
    for (const v of e.variants) {
      if (pick < v.weight) { out[e.id] = v.id; break; }
      pick -= v.weight;
    }
  }
  return out;
}
