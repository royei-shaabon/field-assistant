import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { Invalid, NotFound } from "@/lib/store";

const fail = (e: unknown) => {
  if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
  if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
  throw e;
};

// The field notes of one knowledge base: waiting, approved and rejected.
export async function GET(_request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId } = await params;
  try {
    return Response.json({ notes: await (await envStore()).listNotes(kbId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}

// The implementer writes a note. It is approved at once: the implementer is the one who approves.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`note:${clientKey(request)}`, LIMITS.note)) return tooMany();
  if (tooLarge(request, 6000)) return Response.json({ error: "too large" }, { status: 413 });
  const { kbId } = await params;
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  try {
    const note = await (await envStore()).addNote(kbId, { text: typeof body?.text === "string" ? body.text : "", from: "implementer", approve: true });
    log.info("note.added", { env: await currentEnvId(), kb: kbId, from: "implementer", chars: note.text.length });
    return Response.json({ note });
  } catch (e) {
    return fail(e);
  }
}

// Approve, reject or correct a note.
export async function PATCH(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`note-decide:${clientKey(request)}`, LIMITS.index)) return tooMany();
  if (tooLarge(request, 6000)) return Response.json({ error: "too large" }, { status: 413 });
  const { kbId } = await params;
  const body = (await request.json().catch(() => null)) as { id?: unknown; status?: unknown; text?: unknown } | null;
  const status = body?.status === "approved" || body?.status === "rejected" || body?.status === "pending" ? body.status : undefined;
  if (typeof body?.id !== "string") return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const note = await (await envStore()).decideNote(kbId, body.id, { ...(status ? { status } : {}), ...(typeof body.text === "string" ? { text: body.text } : {}) });
    log.info("note.decided", { env: await currentEnvId(), kb: kbId, status: note.status, from: note.from });
    return Response.json({ note });
  } catch (e) {
    return fail(e);
  }
}
