import { cookies } from "next/headers";
import { secretMatches } from "../store/envs";
import { cookieName, currentEnv, MAIN_ENV } from "./env";
import { sameSecret, validSession } from "./session";

export const ADMIN_COOKIE = "kb_admin";

// "open": no password is configured and this is not production. "closed": no password in
// production, or no such environment.
export type AdminState = "open" | "ok" | "login" | "closed";

// The main environment's password is the server's (ADMIN_PASSWORD); every other environment
// has its own, kept as a hash.
export async function passwordMatches(password: string): Promise<boolean> {
  const env = await currentEnv();
  if (!env) return false;
  if (env.id === MAIN_ENV) {
    const real = process.env.ADMIN_PASSWORD;
    return Boolean(real) && sameSecret(password, real!);
  }
  return secretMatches(password, env.adminHash);
}

// Signed in to the main environment: the main administrator, who may enter every environment.
export async function isMaster(): Promise<boolean> {
  if (!process.env.ADMIN_PASSWORD) return process.env.NODE_ENV !== "production";
  return validSession("admin", (await cookies()).get(ADMIN_COOKIE)?.value);
}

export async function adminState(): Promise<AdminState> {
  const env = await currentEnv();
  if (!env) return "closed";
  if (env.id === MAIN_ENV) {
    if (!process.env.ADMIN_PASSWORD) return process.env.NODE_ENV === "production" ? "closed" : "open";
    return (await isMaster()) ? "ok" : "login";
  }
  if (await isMaster()) return "ok";
  return validSession("admin", (await cookies()).get(cookieName(ADMIN_COOKIE, env.id))?.value, Date.now(), env.id) ? "ok" : "login";
}

export async function isAdmin(): Promise<boolean> {
  const s = await adminState();
  return s === "ok" || s === "open";
}

export const forbidden = () => Response.json({ error: "unauthorized" }, { status: 401 });
