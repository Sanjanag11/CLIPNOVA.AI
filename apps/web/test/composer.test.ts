import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "clipnova-test-"));
process.env.CLIPNOVA_DATA_DIR = dir;

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const itf = it.skipIf(!hasFfmpeg);

let FfmpegComposer: typeof import("../lib/composer").FfmpegComposer;
let OUTPUT_SIZE: typeof import("../lib/composer").OUTPUT_SIZE;
let LocalVideoStore: typeof import("../lib/video-store").LocalVideoStore;
let route: { GET: (req: Request, ctx: { params: Promise<{ name: string }> }) => Promise<Response> };
let scenesDir: string, videosDir: string;

/** A real mp4: `seconds` long, at the given size/fps, so the composer has genuine input. */
function makeClip(name: string, seconds: number, w: number, h: number, fps: number) {
  const out = join(scenesDir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds}`, "-pix_fmt", "yuv420p", out]);
  return `file://${out}`;
}
function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,pix_fmt,r_frame_rate:format=duration", "-of", "json", file]).toString();
  const j = JSON.parse(out);
  const [n, d] = j.streams[0].r_frame_rate.split("/").map(Number);
  return { w: j.streams[0].width, h: j.streams[0].height, codec: j.streams[0].codec_name, pix: j.streams[0].pix_fmt, fps: n / d, seconds: Number(j.format.duration) };
}
const onDisk = (url: string) => join(videosDir, url.split("/").pop()!);

beforeAll(async () => {
  ({ FfmpegComposer, OUTPUT_SIZE } = await import("../lib/composer"));
  ({ LocalVideoStore } = await import("../lib/video-store"));
  route = await import("../app/api/videos/[name]/route");
  const vs = await import("../lib/video-store");
  scenesDir = vs.scenesDir(); videosDir = vs.videosDir();
  await new LocalVideoStore().save("warmup", new Uint8Array([1])); // creates the directory
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const scene = (uri: string, d = 2) => ({ outputUri: uri, durationSeconds: d, seed: 1, gpuSeconds: 1 });

describe("FfmpegComposer", () => {
  itf("stitches scenes of different sizes and frame rates into one H.264 video in every shape", async () => {
    const a = makeClip("a.mp4", 2, 704, 1280, 24);   // portrait, like Wan
    const b = makeClip("b.mp4", 2, 720, 480, 8);     // landscape 8 fps, like CogVideoX
    const c = new FfmpegComposer();
    for (const aspect of ["9:16", "16:9", "1:1", "4:5"] as const) {
      const url = await c.compose("gen_1", [scene(a), scene(b)], { aspectRatio: aspect, watermark: false });
      expect(url).toMatch(/^\/api\/videos\/gen_1-[0-9a-f-]{36}\.mp4$/);
      const p = probe(onDisk(url));
      const [w, h] = OUTPUT_SIZE[aspect];
      expect(p).toMatchObject({ w, h, codec: "h264", pix: "yuv420p", fps: 24 });
      expect(p.seconds).toBeGreaterThan(3.8);
      expect(p.seconds).toBeLessThan(4.3);
    }
  });

  itf("handles a single scene", async () => {
    const url = await new FfmpegComposer().compose("gen_2", [scene(makeClip("single.mp4", 1, 640, 360, 24), 1)], { aspectRatio: "9:16", watermark: false });
    expect(probe(onDisk(url)).seconds).toBeGreaterThan(0.8);
  });

  itf("stamps the watermark on free-plan videos (and only those)", async () => {
    const clip = makeClip("wm.mp4", 1, 640, 360, 24);
    const c = new FfmpegComposer();
    const plain = await c.compose("gen_3", [scene(clip, 1)], { aspectRatio: "16:9", watermark: false });
    const marked = await c.compose("gen_3", [scene(clip, 1)], { aspectRatio: "16:9", watermark: true });
    // Crop the bottom-right corner of the first frame of each and compare the pixels.
    const corner = (file: string) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "crop=220:60:iw-220:ih-60", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 22 });
    const a = corner(onDisk(plain)), b = corner(onDisk(marked));
    expect(a.length).toBe(b.length);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 20) diff++;
    expect(diff).toBeGreaterThan(200); // visibly different: text and a dark box were drawn
    // and the rest of the frame is untouched
    const top = (file: string) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "crop=200:60:0:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 22 });
    const ta = top(onDisk(plain)), tb = top(onDisk(marked));
    let tdiff = 0;
    for (let i = 0; i < ta.length; i++) if (Math.abs(ta[i]! - tb[i]!) > 20) tdiff++;
    expect(tdiff).toBeLessThan(ta.length * 0.02);
  });

  it("refuses files outside the scene directory and non-stored URIs", async () => {
    const c = new FfmpegComposer();
    await expect(c.compose("g", [scene("file:///etc/passwd")], { aspectRatio: "9:16", watermark: false })).rejects.toThrow(/outside the storage directory/);
    await expect(c.compose("g", [scene(`file://${scenesDir}/../../etc/passwd`)], { aspectRatio: "9:16", watermark: false })).rejects.toThrow(/outside/);
    await expect(c.compose("g", [scene("https://evil.example/x.mp4")], { aspectRatio: "9:16", watermark: false })).rejects.toThrow(/only stored files/);
    await expect(c.compose("g", [], { aspectRatio: "9:16", watermark: false })).rejects.toThrow(/no scenes/);
  });

  itf("fails with a clear error on a corrupt scene (so the workflow refunds)", async () => {
    const bad = join(scenesDir, "corrupt.mp4");
    writeFileSync(bad, Buffer.from("this is not a video".repeat(100)));
    await expect(new FfmpegComposer().compose("g", [scene(`file://${bad}`)], { aspectRatio: "9:16", watermark: false })).rejects.toThrow(/ffmpeg failed/);
  });

  it("builds an argument list (no shell), with the watermark only when asked", () => {
    const c = new FfmpegComposer();
    const plain = c.buildArgs(["/a.mp4", "/b.mp4"], "/o.mp4", "9:16", false);
    const marked = c.buildArgs(["/a.mp4", "/b.mp4"], "/o.mp4", "9:16", true, "/font.ttf");
    expect(plain.join(" ")).toContain("concat=n=2:v=1:a=0");
    expect(plain.join(" ")).not.toContain("drawtext");
    expect(marked.join(" ")).toContain("drawtext=fontfile=/font.ttf:text='ClipNova.ai'");
    expect(plain.at(-1)).toBe("/o.mp4");
    expect(plain.some((x) => x.includes(";") && !x.startsWith("["))).toBe(false); // filter graph is one argument
  });
});

describe("LocalVideoStore", () => {
  it("writes atomically under the scenes directory and rejects unsafe keys", async () => {
    const uri = await new LocalVideoStore().save("gen_9-s0-3", new Uint8Array([1, 2, 3]));
    expect(uri).toBe(`file://${join(scenesDir, "gen_9-s0-3.mp4")}`);
    expect(Array.from(readFileSync(join(scenesDir, "gen_9-s0-3.mp4")))).toEqual([1, 2, 3]);
    for (const k of ["../x", "a/b", "", "a b", "x".repeat(200)]) await expect(new LocalVideoStore().save(k, new Uint8Array([1]))).rejects.toThrow(/unsafe/);
  });
});

describe("GET /api/videos/:name", () => {
  const get = (name: string, headers: Record<string, string> = {}, qs = "") =>
    route.GET(new Request(`http://x/api/videos/${name}${qs}`, { headers }), { params: Promise.resolve({ name }) });

  itf("serves the file, supports Range requests and downloads", async () => {
    const clip = makeClip("serve.mp4", 1, 320, 240, 24);
    const url = await new FfmpegComposer().compose("gen_5", [scene(clip, 1)], { aspectRatio: "1:1", watermark: false });
    const name = url.split("/").pop()!;
    const size = statSync(onDisk(url)).size;

    const full = await get(name);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect((await full.arrayBuffer()).byteLength).toBe(size);

    const part = await get(name, { range: "bytes=0-99" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-99/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = await get(name, { range: "bytes=-50" });
    expect(tail.headers.get("content-range")).toBe(`bytes ${size - 50}-${size - 1}/${size}`);
    expect((await get(name, { range: `bytes=${size + 10}-` })).status).toBe(416);

    const dl = await get(name, {}, "?download=1");
    expect(dl.headers.get("content-disposition")).toContain("attachment");
  });

  it("returns 404 for traversal, odd names and missing files", async () => {
    for (const n of ["..%2F..%2Fetc%2Fpasswd", "../../etc/passwd", "a.txt", "nope.mp4", ".mp4"]) expect((await get(n)).status).toBe(404);
  });
});
