import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AspectRatio, Composer, SceneResult } from "@clipnova/core";
import { pathWithin, scenesDir, videosDir } from "./video-store";

const run = promisify(execFile);

/** Output size per shape (720p class; Pro 1080p arrives with the real pipeline). */
export const OUTPUT_SIZE: Record<AspectRatio, [number, number]> = {
  "9:16": [720, 1280], "16:9": [1280, 720], "1:1": [720, 720], "4:5": [720, 900],
};
const FPS = 24;

const FONT_CANDIDATES = [
  process.env.CLIPNOVA_FONT_FILE,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
].filter(Boolean) as string[];

export class ComposeError extends Error {}

export interface FfmpegComposerOptions {
  ffmpeg?: string;
  scenesDir?: string;
  outDir?: string;
  /** URL prefix the finished files are served from. */
  publicBase?: string;
  timeoutMs?: number;
}

/**
 * Stitches rendered scenes into one MP4: every scene is scaled and cropped to the requested shape,
 * normalised to 24 fps, joined, and (on plans with a watermark) stamped. No shell is involved:
 * ffmpeg is started with an argument list and may only read files from the scene directory.
 */
export class FfmpegComposer implements Composer {
  constructor(private readonly o: FfmpegComposerOptions = {}) {}

  /** The ffmpeg arguments, exposed so they can be unit-tested without running ffmpeg. */
  buildArgs(inputs: string[], out: string, aspect: AspectRatio, watermark: boolean, font?: string): string[] {
    const [w, h] = OUTPUT_SIZE[aspect];
    const norm = inputs.map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
    const join = inputs.length > 1 ? `${inputs.map((_, i) => `[v${i}]`).join("")}concat=n=${inputs.length}:v=1:a=0[vc]` : "[v0]null[vc]";
    const mark = watermark
      ? `[vc]drawtext=fontfile=${font}:text='ClipNova.ai':fontcolor=white@0.85:fontsize=${Math.round(h / 32)}:x=w-tw-${Math.round(w / 36)}:y=h-th-${Math.round(w / 36)}:box=1:boxcolor=black@0.35:boxborderw=10[v]`
      : "[vc]null[v]";
    return [
      "-hide_banner", "-loglevel", "error", "-y",
      ...inputs.flatMap((p) => ["-i", p]),
      "-filter_complex", [...norm, join, mark].join(";"),
      "-map", "[v]", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ];
  }

  async compose(generationId: string, scenes: SceneResult[], opts: { aspectRatio: AspectRatio; watermark: boolean }): Promise<string> {
    if (!scenes.length) throw new ComposeError("no scenes to compose");
    const sdir = this.o.scenesDir ?? scenesDir();
    const odir = this.o.outDir ?? videosDir();
    const inputs = scenes.map((s) => pathWithin(s.outputUri, sdir));
    let font: string | undefined;
    if (opts.watermark) {
      font = FONT_CANDIDATES.find((f) => existsSync(f));
      // A free-plan video must never ship without its watermark: fail (and refund) instead.
      if (!font) throw new ComposeError("no font available for the watermark (set CLIPNOVA_FONT_FILE)");
    }
    await mkdir(odir, { recursive: true });
    const name = `${generationId.replace(/[^A-Za-z0-9_-]/g, "")}-${randomUUID()}.mp4`;
    const out = join(odir, name);
    try {
      await run(this.o.ffmpeg ?? "ffmpeg", this.buildArgs(inputs, out, opts.aspectRatio, opts.watermark, font), {
        timeout: this.o.timeoutMs ?? 5 * 60_000, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ComposeError(`ffmpeg failed: ${msg.slice(0, 300)}`);
    }
    return `${this.o.publicBase ?? "/api/videos"}/${name}`;
  }
}
