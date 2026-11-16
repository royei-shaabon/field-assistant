// Which environment a request belongs to. A technician's or implementer's page lives at
// /e/<envId>/..., and every request that page makes (a fetch, a picture, a link to the manual)
// carries the page's address as its Referer, so the environment follows from it. A script can
// name the environment itself with the x-ridd-env header. Anything else is the main environment.
//
// The answer is only "which environment is being asked for", never "allowed": every route still
// checks the caller's session, and a session is good for one environment only.
import { headers } from "next/headers";
import { activity, envRegistry, kbStore } from "../store";
import { ENV_ID, MAIN_ENV, type EnvMeta } from "../store/envs";

export { MAIN_ENV };

export function envIdFromPath(pathname: string): string | null {
  const id = /^\/e\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return id && ENV_ID.test(id) ? id : null;
}

export function envIdFrom(header: string | null, referer: string | null): string {
  if (header && ENV_ID.test(header)) return header;
  try {
    return (referer && envIdFromPath(new URL(referer).pathname)) || MAIN_ENV;
  } catch {
    return MAIN_ENV;
  }
}

export async function currentEnvId(): Promise<string> {
  try {
    const h = await headers();
    return envIdFrom(h.get("x-ridd-env"), h.get("referer"));
  } catch {
    // Outside a request (a script, a test): the main environment.
    return MAIN_ENV;
  }
}

// The environment of this request, or null when there is no such environment or it is disabled.
export async function currentEnv(): Promise<EnvMeta | null> {
  const env = await envRegistry().get(await currentEnvId());
  return env && !env.disabled ? env : null;
}

export const envStore = async () => kbStore(await currentEnvId());
export const envActivity = async () => activity(await currentEnvId());

// The cookie that holds a session, one per environment, so being signed in to one customer's
// environment says nothing about another's.
export const cookieName = (base: string, envId: string) => (envId === MAIN_ENV ? base : `${base}_${envId}`);
