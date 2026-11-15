import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { aiConfigured, ensureSeed } from "@/lib/server/kbs";
import { EMPTY_USAGE, Invalid, kbStore } from "@/lib/store";

export async function GET() {
  if (!(await isAdmin())) return forbidden();
  await ensureSeed();
  const store = kbStore();
  const kbs = await Promise.all((await store.listKbs()).map(async (kb) => ({ ...kb, docs: await store.listDocs(kb.id), usage: await store.getUsage(kb.id) })));
  return Response.json({ kbs, ai: aiConfigured(), accessCode: Boolean(process.env.ACCESS_CODE) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const body = (await request.json().catch(() => null)) as { name?: unknown; description?: unknown } | null;
  if (typeof body?.name !== "string") return Response.json({ error: "name" }, { status: 400 });
  try {
    const kb = await kbStore().createKb({ name: body.name, description: typeof body.description === "string" ? body.description : "" });
    return Response.json({ kb: { ...kb, docs: [], usage: EMPTY_USAGE } });
  } catch (e) {
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
