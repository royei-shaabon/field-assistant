import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  poweredByHeader: false,
  // Native module (page pictures): loaded by Node, not bundled.
  serverExternalPackages: ["@napi-rs/canvas"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          // The camera and the microphone are for the live call on this site only.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=()" },
        ],
      },
      {
        // Not for the stored documents: that route sets its own policy per file type.
        source: "/((?!api/kbs/).*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" }],
      },
    ];
  },
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
