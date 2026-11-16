// Who may use the technician's side. The main environment asks for ACCESS_CODE when it is set;
// every other environment asks for its own code when it has one. A signed-in implementer of
// the environment gets in without a code.
import { cookies, headers } from "next/headers";
import { secretMatches } from "../store/envs";
import { adminState } from "./admin-auth";
import { cookieName, currentEnv, MAIN_ENV } from "./env";
import { allow, clientKeyFrom, LIMITS, reset } from "./rate-limit";
import { sameSecret, validSession } from "./session";

export const ACCESS_COOKIE = "kb_access";

// null: this environment asks for no code.
async function codeCheck(): Promise<((code: string) => boolean) | null | "closed"> {
  const env = await currentEnv();
  if (!env) return "closed";
  if (env.id === MAIN_ENV) {
    const real = process.env.ACCESS_CODE;
    return real ? (code) => sameSecret(code.trim(), real) : null;
  }
  return env.accessHash ? (code) => secretMatches(code.trim(), env.accessHash) : null;
}

export async function codeMatches(code: string): Promise<boolean> {
  const check = await codeCheck();
  return typeof check === "function" && check(code);
}

export async function technicianAllowed(): Promise<boolean> {
  const check = await codeCheck();
  if (check === "closed") return false;
  if (!check) return true;
  const env = (await currentEnv())!;
  if (validSession("tech", (await cookies()).get(cookieName(ACCESS_COOKIE, env.id))?.value, Date.now(), env.id)) return true;
  // A script or a check can send the code itself, with the same limits on guessing as the form.
  const h = await headers();
  const sent = h.get("x-access-token");
  if (sent) {
    const key = `access:${clientKeyFrom(h.get("x-forwarded-for"))}`;
    if (!allow(key, LIMITS.login) || !allow("access:all", LIMITS.loginAll)) return false;
    if (check(sent)) {
      reset(key);
      return true;
    }
  }
  return (await adminState()) === "ok";
}

export const needsCode = () => Response.json({ error: "access_code" }, { status: 401 });
