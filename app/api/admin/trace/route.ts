import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { envActivity } from "@/lib/server/env";
import { lastDays } from "@/lib/store/activity";

// The records of this environment's latest live calls, newest first: what was heard, what was
// said, every tool call with what came back and how long it took.
export async function GET(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const days = Math.min(14, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 2));
  return Response.json({ calls: await (await envActivity()).calls(lastDays(days), 30) }, { headers: { "Cache-Control": "no-store" } });
}
