// Signed, expiring session tokens for the two gates (implementer password, technician code).
// A token is "<kind>.<expiry>.<nonce>.<signature>": every sign-in gets its own token, the
// server checks the expiry itself, and the token says nothing about the password.
// The signing key is SESSION_SECRET; without it, a key derived from the configured secrets, so
// changing the password or the code signs everyone out.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionKind = "admin" | "tech";

const TTL: Record<SessionKind, number> = { admin: 12 * 60 * 60, tech: 30 * 24 * 60 * 60 };

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || `${process.env.ADMIN_PASSWORD ?? ""}\n${process.env.ACCESS_CODE ?? ""}`;
  return createHash("sha256").update(`kb-session-key-v2\n${secret}`).digest();
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("hex");

// A session names its environment: it opens that environment and no other. The main
// environment's sessions keep the older four-part form.
export function issueSession(kind: SessionKind, now = Date.now(), env = "main"): { token: string; maxAge: number } {
  const base = `${kind}.${Math.floor(now / 1000) + TTL[kind]}.${randomBytes(9).toString("hex")}`;
  const payload = env === "main" ? base : `${base}.${env}`;
  return { token: `${payload}.${sign(payload)}`, maxAge: TTL[kind] };
}

export function validSession(kind: SessionKind, token: string | undefined, now = Date.now(), env = "main"): boolean {
  if (!token || token.length > 260) return false;
  const parts = token.split(".");
  const wanted = env === "main" ? 4 : 5;
  if (parts.length !== wanted || parts[0] !== kind) return false;
  if (env !== "main" && parts[3] !== env) return false;
  const payload = parts.slice(0, -1).join(".");
  const given = Buffer.from(parts.at(-1)!);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Number(parts[1]) * 1000 > now;
}

export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function sessionCookie(name: string, token: string, maxAge: number, sameSite: "Strict" | "Lax"): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}
