import { ADMIN_COOKIE, passwordMatches } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, reset, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { issueSession, sessionCookie } from "@/lib/server/session";

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) return Response.json({ error: "no password configured" }, { status: 503 });
  const key = `login:${clientKey(request)}`;
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(key, LIMITS.login) || !allow("login:all", LIMITS.loginAll)) return tooMany();
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (typeof body?.password !== "string" || !passwordMatches(body.password)) {
    await new Promise((r) => setTimeout(r, 600)); // slows guessing
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  reset(key);
  const { token, maxAge } = issueSession("admin");
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(ADMIN_COOKIE, token, maxAge, "Strict") } });
}

// Sign out: the cookie is cleared on this device.
export async function DELETE() {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(ADMIN_COOKIE, "", 0, "Strict") } });
}
