import { ACCESS_COOKIE, codeMatches } from "@/lib/server/access";
import { cookieName, currentEnvId } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, reset, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { issueSession, sessionCookie } from "@/lib/server/session";

// A technician enters the access code once; the phone then keeps a signed session for 30 days.
// The session opens this environment only.
export async function POST(request: Request) {
  const key = `access:${clientKey(request)}`;
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(key, LIMITS.login) || !allow("access:all", LIMITS.loginAll)) return tooMany();
  const env = await currentEnvId();
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || !(await codeMatches(body.code))) {
    // An empty request is the screen asking whether a code is needed, not an attempt.
    if (typeof body?.code === "string" && body.code) log.warn("auth.failed", { env, who: "technician" });
    await new Promise((r) => setTimeout(r, 600)); // slows guessing
    return Response.json({ error: "wrong code" }, { status: 401 });
  }
  reset(key);
  log.info("auth.ok", { env, who: "technician" });
  const { token, maxAge } = issueSession("tech", Date.now(), env);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(cookieName(ACCESS_COOKIE, env), token, maxAge, "Lax") } });
}
