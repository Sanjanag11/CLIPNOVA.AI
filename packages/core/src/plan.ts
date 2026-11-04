import { z } from "zod";

/** Launch languages. Add a code here + a provider-support row to add a language. */
export const LANGUAGES = ["en", "hi", "mr", "kn", "gu", "bn"] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;

export const CATEGORIES = [
  "comedy", "romance", "drama", "fantasy", "fiction", "news",
  "promotional", "education", "motivation", "lifestyle", "storytelling",
] as const;
export const CategorySchema = z.enum(CATEGORIES);

/** Allowed output durations in seconds. 30 s is gated to premium plans (see plans.ts). */
export const DURATIONS = [4, 6, 8, 12, 30] as const;
export const DurationSchema = z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(12), z.literal(30)]);
export type Duration = z.infer<typeof DurationSchema>;

export const AspectRatioSchema = z.enum(["9:16", "1:1", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const ModeSchema = z.enum(["t2v", "i2v", "v2v"]);
export type Mode = z.infer<typeof ModeSchema>;

export const CharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  appearance: z.string().min(1),
  referenceAssetIds: z.array(z.string()).default([]),
  voiceId: z.string().optional(),
});
export type Character = z.infer<typeof CharacterSchema>;

export const ScenePlanSchema = z.object({
  index: z.number().int().nonnegative(),
  durationSeconds: z.number().positive(),
  action: z.string().min(1),
  characterIds: z.array(z.string()).default([]),
  camera: z.string().optional(),
  motion: z.string().optional(),
  narration: z.string().optional(),
  sfx: z.array(z.string()).default([]),
  continuityNotes: z.string().optional(),
  /** Phrases from the user's original input this scene derives from (intent audit trail). */
  sourcePhrases: z.array(z.string()).default([]),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

/**
 * Creative Plan v1: the structured, model-agnostic representation of what the
 * user wants. Per-model prompt adapters render this; the user's original text
 * is always stored unchanged in `rawInput`.
 */
export const CreativePlanSchema = z.object({
  schemaVersion: z.literal(1),
  rawInput: z.object({
    description: z.string().min(1),
    creativePrompt: z.string().min(1),
  }),
  inputLanguage: z.string().min(2),
  intent: z.object({
    logline: z.string().min(1),
    category: CategorySchema.optional(),
    mood: z.string().optional(),
    platform: z.string().optional(),
  }),
  characters: z.array(CharacterSchema).default([]),
  setting: z.object({
    location: z.string().optional(),
    timeOfDay: z.string().optional(),
    visualStyle: z.string().optional(),
    lighting: z.string().optional(),
  }).default({}),
  scenes: z.array(ScenePlanSchema).min(1),
  audio: z.object({
    narrationLanguage: LanguageSchema.default("en"),
    captionLanguage: LanguageSchema.default("en"),
    voiceId: z.string().optional(),
    musicMood: z.string().optional(),
  }).default({ narrationLanguage: "en", captionLanguage: "en" }),
  safety: z.object({
    flags: z.array(z.string()).default([]),
  }).default({ flags: [] }),
});
export type CreativePlan = z.infer<typeof CreativePlanSchema>;

/** Validates plan integrity beyond the schema: scene order and character references. */
export function validatePlanIntegrity(plan: CreativePlan): string[] {
  const issues: string[] = [];
  const ids = new Set(plan.characters.map((c) => c.id));
  plan.scenes.forEach((s, i) => {
    if (s.index !== i) issues.push(`scene at position ${i} has index ${s.index}`);
    for (const cid of s.characterIds) {
      if (!ids.has(cid)) issues.push(`scene ${i} references unknown character "${cid}"`);
    }
  });
  return issues;
}
