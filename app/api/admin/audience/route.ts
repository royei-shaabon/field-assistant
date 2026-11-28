import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { audienceOf } from "@/lib/store";

// Who reads this environment's answers: qualified technicians (warned only where the manual
// warns) or a general audience (warned on every hazard topic).
export async function GET() {
  if (!(await isAdmin())) return forbidden();
  return Response.json({ audience: audienceOf(await (await envStore()).getSettings()) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`audience:${clientKey(request)}`, LIMITS.index)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { audience?: unknown } | null;
  if (body?.audience !== "qualified" && body?.audience !== "general") return Response.json({ error: "audience" }, { status: 400 });
  const store = await envStore();
  await store.putSettings({ ...(await store.getSettings()), audience: body.audience });
  log.info("env.audience", { env: await currentEnvId(), audience: body.audience });
  return Response.json({ audience: body.audience });
}
