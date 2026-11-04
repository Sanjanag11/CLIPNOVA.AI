import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isSafeVideoName, videosDir } from "@/lib/video-store";

/** Serves a finished video with Range support so players can seek. File names are unguessable (random UUID). */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!isSafeVideoName(name)) return Response.json({ error: "Not found" }, { status: 404 });
  const path = join(videosDir(), name);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return Response.json({ error: "Not found" }, { status: 404 });

  const headers: Record<string, string> = {
    "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff",
  };
  if (new URL(req.url).searchParams.get("download") === "1") headers["content-disposition"] = 'attachment; filename="clipnova-video.mp4"';

  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start); end = Math.min(info.size - 1, end);
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${info.size}` } });
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
      status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { ...headers, "content-length": String(info.size) } });
}
