import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { envActivity } from "@/lib/server/env";
import { lastDays } from "@/lib/store/activity";

// The latest questions and answers of this environment (text only), newest first. A
// conversation the technician removed from their own list is still here, marked as removed.
export async function GET(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const days = Math.min(30, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 7));
  return Response.json({ records: await (await envActivity()).recent(lastDays(days), 200) }, { headers: { "Cache-Control": "no-store" } });
}
