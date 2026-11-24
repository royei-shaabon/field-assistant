import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { envActivity } from "@/lib/server/env";
import { span } from "@/lib/server/log";
import { lastDays } from "@/lib/store/activity";
import { gaps } from "@/lib/store/gaps";

// The questions of the last 30 days that this environment's manuals did not answer, the most
// asked first. Read from the conversation log; text only.
export async function GET(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const kbId = new URL(request.url).searchParams.get("kbId")?.slice(0, 80) || undefined;
  const stage = span("admin.gaps", {});
  const records = await (await envActivity()).recent(lastDays(30), 2000);
  stage.part("read");
  const list = gaps(records, kbId);
  stage.end({ records: records.length, gaps: list.length });
  return Response.json({ gaps: list, read: records.length }, { headers: { "Cache-Control": "no-store" } });
}
