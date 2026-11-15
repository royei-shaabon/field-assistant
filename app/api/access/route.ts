import { ACCESS_COOKIE, checkAccessCode } from "@/lib/server/access";

// A technician enters the access code once; the phone then keeps a signed cookie.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const token = typeof body?.code === "string" ? checkAccessCode(body.code) : null;
  if (!token) {
    await new Promise((r) => setTimeout(r, 600)); // slows guessing
    return Response.json({ error: "wrong code" }, { status: 401 });
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return Response.json({ ok: true }, { headers: { "Set-Cookie": `${ACCESS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${secure}` } });
}
