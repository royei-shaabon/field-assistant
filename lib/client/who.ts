// Which technician is using this phone: a name picked from the list the implementer keeps.
// It is remembered on the phone, for each environment. It is not a login: it only lets the
// implementer see who asked and who reported a fix.
import { envSuffix } from "./env";

const key = () => `kb.who${envSuffix()}`;

export function savedWho(): string {
  try {
    return localStorage.getItem(key()) ?? "";
  } catch {
    return "";
  }
}

export function saveWho(name: string): void {
  try {
    if (name) localStorage.setItem(key(), name);
    else localStorage.removeItem(key());
  } catch {
    // A phone that refuses storage asks again next time.
  }
}
