import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { cleanTechnicians } from "@/lib/store";

// The names a technician picks from on first entry. Not a login: it tells who asked and who reported a fix.
export async function GET() {
  if (!(await isAdmin())) return forbidden();
  return Response.json({ technicians: (await (await envStore()).getSettings()).technicians ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`technicians:${clientKey(request)}`, LIMITS.index)) return tooMany();
  if (tooLarge(request, 20_000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { technicians?: unknown } | null;
  const technicians = cleanTechnicians(body?.technicians);
  const store = await envStore();
  const settings = { ...(await store.getSettings()) };
  if (technicians.length) settings.technicians = technicians;
  else delete settings.technicians;
  await store.putSettings(settings);
  log.info("env.technicians", { env: await currentEnvId(), count: technicians.length });
  return Response.json({ technicians });
}
