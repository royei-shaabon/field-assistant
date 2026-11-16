import { forbidden, isMaster } from "@/lib/server/admin-auth";
import { currentEnvId, MAIN_ENV } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { envRegistry } from "@/lib/store";
import { EnvError, envView } from "@/lib/store/envs";

// Environments are the main administrator's: only a session of the main environment, asked
// from the main environment's own screen, may list or create them.
const allowed = async () => (await currentEnvId()) === MAIN_ENV && (await isMaster());

export async function GET() {
  if (!(await allowed())) return forbidden();
  return Response.json({ envs: (await envRegistry().list()).map(envView) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await allowed())) return forbidden();
  if (!allow(`envs:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  if (tooLarge(request, 4000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { id?: unknown; name?: unknown; adminPassword?: unknown; accessCode?: unknown } | null;
  if (typeof body?.id !== "string" || typeof body.name !== "string" || typeof body.adminPassword !== "string") return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const env = await envRegistry().create({ id: body.id, name: body.name, adminPassword: body.adminPassword, accessCode: typeof body.accessCode === "string" ? body.accessCode : undefined });
    log.info("env.created", { env: env.id });
    return Response.json({ env: envView(env) });
  } catch (e) {
    if (e instanceof EnvError) return Response.json({ error: e.message }, { status: e.message === "exists" ? 409 : 400 });
    throw e;
  }
}
