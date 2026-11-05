import { CreativePlanSchema, LANGUAGES, detectLanguage, planCreative, type Language } from "@clipnova/core";
import { ApiError, getService, identify, jsonError } from "@/lib/service";
import { PlanBody } from "@/lib/schemas";

export async function POST(req: Request) {
  try {
    const parsed = PlanBody.safeParse(await req.json());
    if (!parsed.success) throw new ApiError(400, "Describe your idea and add a creative prompt (each up to 1500 characters).", "BAD_REQUEST");
    const b = parsed.data;
    const c = await identify(req, b.plan, b.region);
    const models = (await getService()).registry.select({ mode: b.mode, aspectRatio: b.aspectRatio, region: c.region, bucket: c.bucket, modelId: b.modelId, maxSceneSeconds: 5 });
    const maxClip = Math.min(...models.map((m) => m.profile.maxClipSeconds), 5);
    if (!models.length) throw new ApiError(409, "No model is available for this mode, shape and region.", "NO_MODEL");
    const narration = (LANGUAGES as readonly string[]).includes(b.language) ? (b.language as Language) : "en";
    // Basic planner: splits the idea into scenes. Free to run, never touches credits.
    const plan = CreativePlanSchema.parse(planCreative({
      description: b.description, creativePrompt: b.creativePrompt, durationSeconds: b.durationSeconds, maxClipSeconds: maxClip,
      narrationLanguage: narration, category: b.category, mood: b.mood, camera: b.camera, motion: b.motion,
      background: b.background, style: b.style, characters: b.characters,
    }));
    return Response.json({ plan, detected: detectLanguage(b.description), planner: "basic" });
  } catch (e) { return jsonError(e); }
}
