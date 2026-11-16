import { envStore } from "@/lib/server/env";
import { embedder } from "@/lib/docs/embed";
import { forbidden, isAdmin, isMaster } from "@/lib/server/admin-auth";
import { currentEnv, currentEnvId, MAIN_ENV } from "@/lib/server/env";
import { envView } from "@/lib/store/envs";
import { aiConfigured, ensureSeed } from "@/lib/server/kbs";
import { EMPTY_USAGE, Invalid } from "@/lib/store";

export async function GET() {
  if (!(await isAdmin())) return forbidden();
  if ((await currentEnvId()) === MAIN_ENV) await ensureSeed();
  const store = await envStore();
  const using = embedder();
  const kbs = await Promise.all(
    (await store.listKbs()).map(async (kb) => {
      const docs = await Promise.all(
        (await store.listDocs(kb.id)).map(async (doc) => {
          // How many passages of the document can be searched by meaning with the current model.
          const info = using ? await store.vectorInfo(kb.id, doc.id) : null;
          return { ...doc, indexed: using && info && info.model === using.model ? info.count : 0 };
        }),
      );
      return { ...kb, docs, usage: await store.getUsage(kb.id) };
    }),
  );
  const env = (await currentEnv())!;
  // Whether technicians of this environment are asked for a code.
  const accessCode = env.id === MAIN_ENV ? Boolean(process.env.ACCESS_CODE) : Boolean(env.accessHash);
  return Response.json({ kbs, ai: aiConfigured(), accessCode, embeddings: using?.model ?? null, env: envView(env), master: env.id === MAIN_ENV && (await isMaster()) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return forbidden();
  const body = (await request.json().catch(() => null)) as { name?: unknown; description?: unknown } | null;
  if (typeof body?.name !== "string") return Response.json({ error: "name" }, { status: 400 });
  try {
    const kb = await (await envStore()).createKb({ name: body.name, description: typeof body.description === "string" ? body.description : "" });
    return Response.json({ kb: { ...kb, docs: [], usage: EMPTY_USAGE } });
  } catch (e) {
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
