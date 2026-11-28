import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnvId, envStore } from "@/lib/server/env";
import { addFieldNote } from "@/lib/server/field-note";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { Invalid, knownTechnician, NotFound } from "@/lib/store";

// A technician shares what solved a fault. The note waits for the implementer's approval:
// nothing a technician writes reaches other technicians before a person has read it.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (tooLarge(request, 6000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(`note:${clientKey(request)}`, LIMITS.note)) return tooMany();
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; text?: unknown; who?: unknown } | null;
  if (typeof body?.kbId !== "string" || typeof body.text !== "string") return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const store = await envStore();
    const { shown } = await addFieldNote(store, await currentEnvId(), body.kbId, body.text, "technician", knownTechnician(await store.getSettings().catch(() => ({})), body.who));
    return Response.json({ ok: true, shown });
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
