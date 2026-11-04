import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // ffmpeg tests encode real video; give them room when several files run in parallel.
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
