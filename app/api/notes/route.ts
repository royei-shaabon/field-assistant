import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnvId, envStore } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { Invalid, NotFound } from "@/lib/store";

// A technician shares what solved a fault. The note waits for the implementer's approval:
// nothing a technician writes reaches other technicians before a person has read it.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (tooLarge(request, 6000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(`note:${clientKey(request)}`, LIMITS.note)) return tooMany();
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; text?: unknown } | null;
  if (typeof body?.kbId !== "string" || typeof body.text !== "string") return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const note = await (await envStore()).addNote(body.kbId, { text: body.text, from: "technician" });
    log.info("note.added", { env: await currentEnvId(), kb: body.kbId, from: "technician", chars: note.text.length });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
