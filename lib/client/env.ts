// Which environment this page belongs to, read from its address: /e/<envId>/... is a
// customer's environment, anything else is the main one. The server works out the same thing
// from the page's address, so the two always agree.
const PATH = /^\/e\/([a-z0-9][a-z0-9-]{1,39})(?:\/|$)/;

// "" for the main environment, "/e/<envId>" for any other: what links inside the app start with.
export function envBase(): string {
  if (typeof window === "undefined") return "";
  const id = PATH.exec(window.location?.pathname ?? "")?.[1];
  return id ? `/e/${id}` : "";
}

// Names this environment's data on the phone, so two environments never share conversations.
export function envSuffix(): string {
  const base = envBase();
  return base ? `.${base.slice(3)}` : "";
}
