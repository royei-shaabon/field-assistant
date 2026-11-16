import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnvId, envActivity } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

// The technician removed a conversation from their list. Nothing is deleted (soft delete):
// the log keeps it and marks when it was removed.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`remove:${clientKey(request)}`, LIMITS.ask)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { conversationId?: unknown } | null;
  const ok = typeof body?.conversationId === "string" && (await (await envActivity()).markRemoved(body.conversationId));
  if (!ok) return Response.json({ error: "bad request" }, { status: 400 });
  log.info("conversation.removed", { env: await currentEnvId() });
  return Response.json({ ok: true });
}
