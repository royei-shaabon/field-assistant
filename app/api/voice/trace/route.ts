import { needsCode, technicianAllowed } from "@/lib/server/access";
import { envActivity } from "@/lib/server/env";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import type { CallEvent } from "@/lib/store/activity";

// A piece of a live call's record, sent by the phone every few seconds: what was heard and
// said (as text), each tool call and what it returned. No sound and no pictures.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`trace:${clientKey(request)}`, LIMITS.trace)) return tooMany();
  if (tooLarge(request, 200_000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { callId?: unknown; kbId?: unknown; kind?: unknown; conversationId?: unknown; events?: unknown } | null;
  if (typeof body?.callId !== "string" || typeof body.kbId !== "string" || !Array.isArray(body.events)) return Response.json({ error: "bad request" }, { status: 400 });
  const events = body.events.filter((e): e is CallEvent => typeof e === "object" && e !== null && typeof (e as CallEvent).type === "string");
  const ok = await (await envActivity()).trace(body.callId, { kbId: body.kbId, kind: body.kind === "video" ? "video" : "voice", conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined }, events);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "bad request" }, { status: 400 });
}
