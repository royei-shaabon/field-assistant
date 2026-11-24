import { BUILD } from "@/lib/version";

// Which build is running. Says nothing else, and needs no sign-in: a deploy check reads it.
export function GET() {
  return Response.json({ build: BUILD }, { headers: { "Cache-Control": "no-store" } });
}
