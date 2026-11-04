import { CategorySchema, LANGUAGES, type CreativePlan, type Language } from "./plan";

/**
 * BASIC PLANNER. Deterministic, no AI: it splits the user's idea into scenes and reads out what they typed.
 * It does not understand story, sentiment or characters. The Claude-powered planner (assessment section 7)
 * replaces it behind the same input/output shape.
 */
export interface PlannerInput {
  description: string;
  creativePrompt: string;
  durationSeconds: number;
  /** Longest clip the chosen model can render; the scene count is raised until every scene fits. */
  maxClipSeconds: number;
  /** Narration/caption language the user picked. */
  narrationLanguage?: Language;
  category?: string;
  mood?: string;
  camera?: string;
  motion?: string;
  background?: string;
  style?: string;
  /** Free text, e.g. "Riya — early 20s, curly hair. Her mother — 50s, saree." */
  characters?: string;
}

export interface DetectedLanguage { code: Language; label: string; mixed: boolean }

const HINGLISH = /\b(ke|ki|ka|hai|hain|nahi|nahin|kya|aur|ko|se|mein|par|jab|toh|tha|thi|uthti|bhi|lekin|phir)\b/i;

export function detectLanguage(text: string): DetectedLanguage {
  const has = (re: RegExp) => re.test(text);
  const latin = has(/[A-Za-z]{3,}/);
  if (has(/[ಀ-೿]/)) return { code: "kn", label: latin ? "Kannada + English" : "Kannada", mixed: latin };
  if (has(/[઀-૿]/)) return { code: "gu", label: latin ? "Gujarati + English" : "Gujarati", mixed: latin };
  if (has(/[ঀ-৿]/)) return { code: "bn", label: latin ? "Bengali + English" : "Bengali", mixed: latin };
  if (has(/[ऀ-ॿ]/)) {
    // \b only knows ASCII word characters, so Devanagari words need explicit boundaries.
    const mr = has(/ळ|(?:^|[\s,.!?।])(?:आहे|आहेत|आणि|नाही|मी)(?=$|[\s,.!?।])/u);
    const name = mr ? "Marathi" : "Hindi";
    return { code: mr ? "mr" : "hi", label: latin ? `${name} + English` : name, mixed: latin };
  }
  if (HINGLISH.test(text)) return { code: "hi", label: "Hinglish (Hindi + English)", mixed: true };
  return { code: "en", label: "English", mixed: false };
}

/** Scene counts per requested length, from the approved prototype. */
const SCENES_FOR: Record<number, number> = { 4: 2, 6: 2, 8: 3, 12: 4, 30: 5 };

export function sceneCount(durationSeconds: number, maxClipSeconds: number): number {
  const wanted = SCENES_FOR[durationSeconds] ?? Math.max(1, Math.round(durationSeconds / 3));
  const n = Math.max(wanted, Math.ceil(durationSeconds / maxClipSeconds));
  return Math.min(n, Math.max(1, Math.floor(durationSeconds)));
}

/** Whole-second scene lengths that sum exactly to `total`. */
export function evenSplit(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

function segments(text: string, n: number): string[] {
  let parts = text.split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < n) {
    parts = parts.flatMap((p) => p.split(/\s*(?:—|–|;|,|\bbut\b|\bthen\b|(?<=\s)फिर(?=\s))\s*/iu).map((s) => s.trim()).filter((s) => s.length >= 12));
  }
  return parts.length ? parts : [text.trim()];
}

function parseCharacters(text?: string) {
  if (!text?.trim()) return [];
  return text.split(/\.\s+(?=[A-Z])|\n|;/).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean).slice(0, 6).map((chunk, i) => {
    const m = chunk.match(/^(.{1,40}?)\s*(?:—|–|-|:)\s+(.+)$/);
    const name = (m?.[1] ?? chunk.split(/\s+/).slice(0, 2).join(" ")).trim();
    return { id: `c${i + 1}`, name, appearance: (m?.[2] ?? chunk).trim(), referenceAssetIds: [] as string[] };
  });
}

export function planCreative(input: PlannerInput): CreativePlan {
  const n = sceneCount(input.durationSeconds, input.maxClipSeconds);
  const lengths = evenSplit(input.durationSeconds, n);
  const segs = segments(input.description, n);
  const characters = parseCharacters(input.characters);
  const detected = detectLanguage(input.description);
  const cat = CategorySchema.safeParse((input.category ?? "").toLowerCase());
  const letDecide = (v?: string) => (v && !/let ai decide/i.test(v) ? v : undefined);

  const scenes = lengths.map((d, i) => {
    const k = Math.min(segs.length - 1, Math.floor((i * segs.length) / n));
    const repeat = i > 0 && Math.floor(((i - 1) * segs.length) / n) === k && segs.length < n;
    const text = segs[k]!;
    const lower = text.toLowerCase();
    return {
      index: i, durationSeconds: d,
      action: repeat ? `${text} (continues)` : text,
      characterIds: characters.filter((c) => { const first = c.name.split(/\s+/)[0]!.toLowerCase(); return first.length >= 3 && lower.includes(first); }).map((c) => c.id),
      camera: letDecide(input.camera), motion: letDecide(input.motion),
      sfx: [] as string[], sourcePhrases: [text],
    };
  });

  return {
    schemaVersion: 1,
    rawInput: { description: input.description, creativePrompt: input.creativePrompt },
    inputLanguage: detected.code,
    intent: { logline: input.description.trim().slice(0, 120), category: cat.success ? cat.data : undefined, mood: input.mood },
    characters,
    setting: { location: input.background, visualStyle: input.style },
    scenes,
    audio: { narrationLanguage: LANGUAGES.includes(input.narrationLanguage as Language) ? input.narrationLanguage! : "en", captionLanguage: LANGUAGES.includes(input.narrationLanguage as Language) ? input.narrationLanguage! : "en" },
    safety: { flags: [] },
  };
}
