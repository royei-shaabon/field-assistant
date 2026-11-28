import { envStore } from "@/lib/server/env";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { cleanAbout, cleanYears } from "@/lib/docs/describe";
import { tooLarge } from "@/lib/server/rate-limit";
import { Invalid, NotFound } from "@/lib/store";

export async function PATCH(request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId, docId } = await params;
  if (tooLarge(request, 10_000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { name?: unknown; about?: unknown; years?: unknown } | null;
  try {
    const store = await envStore();
    // The description and the years: what the implementer approved, cleaned. The name as before.
    if (typeof body?.about === "string" || typeof body?.years === "string") {
      const doc = await store.describeDoc(kbId, docId, { ...(typeof body.about === "string" ? { about: cleanAbout(body.about) } : {}), ...(typeof body.years === "string" ? { years: cleanYears(body.years) } : {}) });
      if (typeof body.name !== "string") return Response.json({ doc });
    }
    return Response.json({ doc: await store.renameDoc(kbId, docId, typeof body?.name === "string" ? body.name : "") });
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
