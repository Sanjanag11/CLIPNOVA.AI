import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@clipnova/core"],
  // Database drivers are loaded at runtime on the server, never bundled.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default config;
