import { ADMIN_COOKIE, checkPassword } from "@/lib/server/admin-auth";

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) return Response.json({ error: "no password configured" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const token = typeof body?.password === "string" ? checkPassword(body.password) : null;
  if (!token) {
    await new Promise((r) => setTimeout(r, 600)); // slows guessing
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}` } },
  );
}
