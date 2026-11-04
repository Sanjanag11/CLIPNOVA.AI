import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { VideoStore } from "@clipnova/core";

export function dataDir(): string {
  return resolve(process.env.CLIPNOVA_DATA_DIR ?? join(process.cwd(), ".data"));
}
export const scenesDir = () => join(dataDir(), "scenes");
export const videosDir = () => join(dataDir(), "videos");

const SAFE = /^[A-Za-z0-9_.-]{1,120}$/;

/** Dev storage on local disk. Production swaps this for object storage (Cloudflare R2) behind the same interface. */
export class LocalVideoStore implements VideoStore {
  constructor(private readonly dir: string = scenesDir()) {}

  async save(key: string, bytes: Uint8Array): Promise<string> {
    if (!SAFE.test(key)) throw new Error("unsafe storage key");
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${key}.mp4`);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path); // never expose a half-written file
    return `file://${path}`;
  }
}

/** Resolves a stored file:// URI back to a path, refusing anything outside the allowed directory. */
export function pathWithin(uri: string, dir: string): string {
  if (!uri.startsWith("file://")) throw new Error("only stored files can be composed");
  const p = resolve(uri.slice("file://".length));
  const root = resolve(dir) + sep;
  if (!p.startsWith(root)) throw new Error("file is outside the storage directory");
  return p;
}

export const isSafeVideoName = (n: string) => SAFE.test(n) && n.endsWith(".mp4");
