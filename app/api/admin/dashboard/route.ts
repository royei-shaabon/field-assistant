import { forbidden, isAdmin, isMaster } from "@/lib/server/admin-auth";
import { currentEnv, MAIN_ENV } from "@/lib/server/env";
import { activity, envRegistry, kbStore } from "@/lib/store";
import { lastDays } from "@/lib/store/activity";
import { envView, type EnvMeta } from "@/lib/store/envs";

const DAYS = 14;

async function summary(env: EnvMeta, days: string[]) {
  const store = kbStore(env.id);
  const kbs = await store.listKbs();
  const docs = (await Promise.all(kbs.map((k) => store.listDocs(k.id)))).reduce((n, list) => n + list.length, 0);
  return { env: envView(env), kbs: kbs.length, docs, days: await activity(env.id).days(days) };
}

// The numbers behind the dashboard: the last two weeks, day by day. The main administrator,
// on the main environment's screen, gets every environment; anyone else gets their own.
export async function GET() {
  if (!(await isAdmin())) return forbidden();
  const env = (await currentEnv())!;
  const days = lastDays(DAYS);
  const all = env.id === MAIN_ENV && (await isMaster());
  const envs = all ? await envRegistry().list() : [env];
  return Response.json({ master: all, days, envs: await Promise.all(envs.map((e) => summary(e, days))) }, { headers: { "Cache-Control": "no-store" } });
}
