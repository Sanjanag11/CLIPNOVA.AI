import { AspectRatioSchema, ModeSchema } from "@clipnova/core";
import { z } from "zod";

export const AddonsSchema = z.object({ voice: z.boolean(), music: z.boolean(), sfx: z.boolean() });

export const BaseBody = z.object({
  plan: z.enum(["free", "creator", "pro"]).default("free"),
  region: z.string().length(2).optional(),
});

export const QuoteBody = BaseBody.extend({
  mode: ModeSchema,
  durationSeconds: z.number().int().positive().max(60),
  aspectRatio: AspectRatioSchema,
  modelId: z.string().max(40).optional(),
  addons: AddonsSchema,
});

export const PlanBody = QuoteBody.extend({
  description: z.string().trim().min(1).max(1500),
  creativePrompt: z.string().trim().min(1).max(1500),
  language: z.string().max(5).default("en"),
  category: z.string().max(40).optional(),
  mood: z.string().max(80).optional(),
  camera: z.string().max(120).optional(),
  motion: z.string().max(120).optional(),
  background: z.string().max(200).optional(),
  style: z.string().max(120).optional(),
  characters: z.string().max(1500).optional(),
});

export const GenerateBody = QuoteBody.extend({
  idempotencyKey: z.string().min(8).max(80),
  /** The plan the user reviewed (scene text may have been edited). Validated by the core schema. */
  creativePlan: z.unknown(),
});

export const RegenBody = BaseBody.extend({ idempotencyKey: z.string().min(8).max(80) });
export const RatingBody = BaseBody.extend({ value: z.enum(["up", "down"]) });
