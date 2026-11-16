import { envStore } from "@/lib/server/env";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { Invalid, NotFound } from "@/lib/store";

type Context = { params: Promise<{ kbId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  if (!(await isAdmin())) return forbidden();
  const { kbId } = await params;
  const body = (await request.json().catch(() => null)) as { name?: unknown; description?: unknown; ideas?: unknown } | null;
  try {
    const kb = await (await envStore()).updateKb(kbId, {
      name: typeof body?.name === "string" ? body.name : undefined,
      description: typeof body?.description === "string" ? body.description : undefined,
      ideas: typeof body?.ideas === "boolean" ? body.ideas : undefined,
    });
    return Response.json({ kb });
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  if (!(await isAdmin())) return forbidden();
  const { kbId } = await params;
  try {
    await (await envStore()).deleteKb(kbId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
