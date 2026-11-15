import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The KB and skill prompts are read from disk at runtime by the API route.
  outputFileTracingIncludes: {
    "/api/conversation": ["./knowledge/**/*", "./skills/*/prompt.md", "./skills/*/schema.json", "./skills/*/examples.yaml"],
    "/api/admin/kbs/[kbId]/docs": ["./node_modules/unpdf/dist/**/*", "./node_modules/mammoth/**/*"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
