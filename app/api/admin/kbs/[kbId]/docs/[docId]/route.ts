import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { Invalid, kbStore } from "@/lib/store";

export async function DELETE(_request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId, docId } = await params;
  try {
    await kbStore().deleteDoc(kbId, docId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
