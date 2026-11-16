import { envStore } from "@/lib/server/env";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { Invalid, NotFound } from "@/lib/store";

export async function PATCH(request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId, docId } = await params;
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  try {
    return Response.json({ doc: await (await envStore()).renameDoc(kbId, docId, typeof body?.name === "string" ? body.name : "") });
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId, docId } = await params;
  try {
    await (await envStore()).deleteDoc(kbId, docId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
