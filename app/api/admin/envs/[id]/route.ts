import { forbidden, isMaster } from "@/lib/server/admin-auth";
import { currentEnvId, MAIN_ENV } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { envRegistry } from "@/lib/store";
import { EnvError, envView } from "@/lib/store/envs";

// Rename an environment, replace its password or its technicians' code, or switch it off.
// Nothing here deletes data: a disabled environment answers nobody and keeps everything.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if ((await currentEnvId()) !== MAIN_ENV || !(await isMaster())) return forbidden();
  if (!allow(`envs:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  if (tooLarge(request, 4000)) return Response.json({ error: "too large" }, { status: 413 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { name?: unknown; adminPassword?: unknown; accessCode?: unknown; disabled?: unknown } | null;
  try {
    const env = await envRegistry().update(id, {
      ...(typeof body?.name === "string" ? { name: body.name } : {}),
      ...(typeof body?.adminPassword === "string" ? { adminPassword: body.adminPassword } : {}),
      ...(typeof body?.accessCode === "string" ? { accessCode: body.accessCode } : {}),
      ...(typeof body?.disabled === "boolean" ? { disabled: body.disabled } : {}),
    });
    // What changed, never the new value.
    log.info("env.updated", { env: id, changed: Object.keys(body ?? {}) });
    return Response.json({ env: envView(env) });
  } catch (e) {
    if (e instanceof EnvError) return Response.json({ error: e.message }, { status: e.message === "unknown" ? 404 : 400 });
    throw e;
  }
}
