// Optional gate for the technician area: with ACCESS_CODE set, a phone must enter the code once
// before it can list knowledge bases, ask, or open a source document. A signed-in implementer
// passes too. Without ACCESS_CODE the technician area is open to anyone with the link.
import { cookies, headers } from "next/headers";
import { adminState } from "./admin-auth";
import { allow, clientKeyFrom, LIMITS, reset } from "./rate-limit";
import { sameSecret, validSession } from "./session";

export const ACCESS_COOKIE = "kb_access";

export function codeMatches(code: string): boolean {
  const real = process.env.ACCESS_CODE;
  return Boolean(real) && sameSecret(code.trim(), real!);
}

export async function technicianAllowed(): Promise<boolean> {
  if (!process.env.ACCESS_CODE) return true;
  if (validSession("tech", (await cookies()).get(ACCESS_COOKIE)?.value)) return true;
  // Scripts (scripts/live-check.ts) send the code in a header. Wrong guesses are limited
  // exactly like the code screen, and the limit is checked before the code is.
  const h = await headers();
  const sent = h.get("x-access-token");
  if (sent) {
    const key = `access:${clientKeyFrom(h.get("x-forwarded-for"))}`;
    if (!allow(key, LIMITS.login) || !allow("access:all", LIMITS.loginAll)) return false;
    if (codeMatches(sent)) {
      reset(key);
      return true;
    }
  }
  return (await adminState()) === "ok";
}

export const needsCode = () => Response.json({ error: "access_code" }, { status: 401 });
