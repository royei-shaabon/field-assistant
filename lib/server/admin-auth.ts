// The implementer area (/admin) is behind one shared password (ADMIN_PASSWORD). Signing in
// gives a signed session that expires after 12 hours. Without ADMIN_PASSWORD the area is open
// in development and closed in production.
import { cookies } from "next/headers";
import { sameSecret, validSession } from "./session";

export const ADMIN_COOKIE = "kb_admin";

export type AdminState = "open" | "ok" | "login" | "closed";

export function passwordMatches(password: string): boolean {
  const real = process.env.ADMIN_PASSWORD;
  return Boolean(real) && sameSecret(password, real!);
}

export async function adminState(): Promise<AdminState> {
  if (!process.env.ADMIN_PASSWORD) return process.env.NODE_ENV === "production" ? "closed" : "open";
  return validSession("admin", (await cookies()).get(ADMIN_COOKIE)?.value) ? "ok" : "login";
}

export async function isAdmin(): Promise<boolean> {
  const s = await adminState();
  return s === "ok" || s === "open";
}

export const forbidden = () => Response.json({ error: "unauthorized" }, { status: 401 });
