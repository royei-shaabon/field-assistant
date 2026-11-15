// The implementer area (/admin) is behind one shared password (ADMIN_PASSWORD). The cookie holds
// an HMAC of a fixed label, never the password. Without ADMIN_PASSWORD the area is open in
// development and closed in production.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "kb_admin";

function token(password: string): string {
  return createHmac("sha256", password).update("kb-admin-session-v1").digest("hex");
}

export type AdminState = "open" | "ok" | "login" | "closed";

export function checkPassword(password: string): string | null {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) return null;
  const a = Buffer.from(token(password));
  const b = Buffer.from(token(real));
  return timingSafeEqual(a, b) ? token(real) : null;
}

export async function adminState(): Promise<AdminState> {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) return process.env.NODE_ENV === "production" ? "closed" : "open";
  const cookie = (await cookies()).get(ADMIN_COOKIE)?.value ?? "";
  const expected = token(real);
  return cookie.length === expected.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(expected)) ? "ok" : "login";
}

export async function isAdmin(): Promise<boolean> {
  const s = await adminState();
  return s === "ok" || s === "open";
}

export const forbidden = () => Response.json({ error: "unauthorized" }, { status: 401 });
