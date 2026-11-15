import { ACCESS_COOKIE, codeMatches } from "@/lib/server/access";
import { allow, clientKey, LIMITS, reset, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { issueSession, sessionCookie } from "@/lib/server/session";

// A technician enters the access code once; the phone then keeps a signed session for 30 days.
export async function POST(request: Request) {
  const key = `access:${clientKey(request)}`;
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(key, LIMITS.login) || !allow("access:all", LIMITS.loginAll)) return tooMany();
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || !codeMatches(body.code)) {
    await new Promise((r) => setTimeout(r, 600)); // slows guessing
    return Response.json({ error: "wrong code" }, { status: 401 });
  }
  reset(key);
  const { token, maxAge } = issueSession("tech");
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(ACCESS_COOKIE, token, maxAge, "Lax") } });
}
