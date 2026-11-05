import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { videosDir } from "./video-store";

/** Where finished videos are kept so people can play and download them. */
export interface FileStore {
  /** Saves the bytes and returns the URL the browser should use. */
  put(name: string, bytes: Uint8Array): Promise<string>;
}

const SAFE = /^[A-Za-z0-9_.-]{1,120}$/;

/** Local disk (development). Served by /api/videos/[name]. */
export class LocalFileStore implements FileStore {
  async put(name: string, bytes: Uint8Array): Promise<string> {
    if (!SAFE.test(name) || !name.endsWith(".mp4")) throw new Error("unsafe file name");
    const dir = videosDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(`${path}.tmp`, bytes);
    await rename(`${path}.tmp`, path); // never expose a half-written file
    return `/api/videos/${name}`;
  }
}

/** Vercel Blob (production on Vercel). The token is added automatically when a Blob store is connected to the project. */
export class BlobFileStore implements FileStore {
  async put(name: string, bytes: Uint8Array): Promise<string> {
    if (!SAFE.test(name) || !name.endsWith(".mp4")) throw new Error("unsafe file name");
    const { put } = await import("@vercel/blob");
    const res = await put(`videos/${name}`, Buffer.from(bytes), { access: "public", addRandomSuffix: true, contentType: "video/mp4" });
    return res.url;
  }
}

export function getFileStore(): FileStore {
  return process.env.BLOB_READ_WRITE_TOKEN ? new BlobFileStore() : new LocalFileStore();
}
