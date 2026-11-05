import { join, resolve } from "node:path";

export function dataDir(): string {
  // Local development only: on Vercel videos go to Blob and the database is Postgres, so nothing here should be traced.
  return resolve(/*turbopackIgnore: true*/ process.env.CLIPNOVA_DATA_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), ".data"));
}
export const videosDir = () => join(dataDir(), "videos");

const SAFE = /^[A-Za-z0-9_.-]{1,120}$/;
export const isSafeVideoName = (n: string) => SAFE.test(n) && n.endsWith(".mp4");
