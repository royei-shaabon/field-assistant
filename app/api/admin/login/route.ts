import { ADMIN_COOKIE, passwordMatches } from "@/lib/server/admin-auth";
import { cookieName, currentEnv, MAIN_ENV } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, reset, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { issueSession, sessionCookie } from "@/lib/server/session";

// Signs an implementer in to this environment. The main environment's password is the
// server's own; signing in there is signing in as the main administrator.
export async function POST(request: Request) {
  const env = await currentEnv();
  if (!env || (env.id === MAIN_ENV && !process.env.ADMIN_PASSWORD)) return Response.json({ error: "no password configured" }, { status: 503 });
  const key = `login:${clientKey(request)}`;
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(key, LIMITS.login) || !allow("login:all", LIMITS.loginAll)) return tooMany();
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (typeof body?.password !== "string" || !(await passwordMatches(body.password))) {
    // An empty request is the screen asking whether sign-in is needed, not an attempt.
    if (typeof body?.password === "string" && body.password) log.warn("auth.failed", { env: env.id, who: "admin" });
    await new Promise((r) => setTimeout(r, 600)); // slows guessing
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  reset(key);
  log.info("auth.ok", { env: env.id, who: "admin" });
  const { token, maxAge } = issueSession("admin", Date.now(), env.id);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(cookieName(ADMIN_COOKIE, env.id), token, maxAge, "Strict") } });
}

// Sign out: the cookie is cleared on this device.
export async function DELETE() {
  const env = await currentEnv();
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(cookieName(ADMIN_COOKIE, env?.id ?? MAIN_ENV), "", 0, "Strict") } });
}
