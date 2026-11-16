// Environments: one per customer. Each has its own knowledge bases, settings, usage numbers
// and conversation log, under envs/<envId>/ in the same storage. The first environment,
// "main", is the one that existed before environments did: its data stays at the root, and
// its passwords are the server's own (ADMIN_PASSWORD, ACCESS_CODE). Whoever administers
// "main" is the main administrator and sees every environment.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { BlobDriver } from "./types";

export const MAIN_ENV = "main";
export const ENV_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

export type EnvMeta = {
  id: string;
  name: string;
  createdAt: string;
  // scrypt hashes; the passwords themselves are never stored.
  adminHash?: string;
  // No hash: technicians of this environment need no code.
  accessHash?: string;
  // A disabled environment answers nobody; its data stays.
  disabled?: boolean;
};

// What the screens may see: never a hash.
export type EnvView = { id: string; name: string; createdAt: string; hasAdminPassword: boolean; hasAccessCode: boolean; disabled: boolean; main: boolean };

export const envView = (e: EnvMeta): EnvView => ({ id: e.id, name: e.name, createdAt: e.createdAt, hasAdminPassword: Boolean(e.adminHash), hasAccessCode: Boolean(e.accessHash), disabled: Boolean(e.disabled), main: e.id === MAIN_ENV });

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(secret, salt, 32).toString("hex")}`;
}

export function secretMatches(secret: string, hash: string | undefined): boolean {
  const [scheme, salt, digest] = (hash ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  const given = scryptSync(secret, Buffer.from(salt, "hex"), expected.length);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// A view of the storage that only sees keys under one prefix.
export class PrefixDriver implements BlobDriver {
  constructor(
    private inner: BlobDriver,
    private prefix: string,
  ) {}
  private key(key: string): string {
    if (key.split("/").includes("..")) throw new Error("bad key");
    return this.prefix + key;
  }
  read(key: string) {
    return this.inner.read(this.key(key));
  }
  write(key: string, data: Buffer) {
    return this.inner.write(this.key(key), data);
  }
  remove(prefix: string) {
    return this.inner.remove(this.key(prefix));
  }
  async list(prefix: string) {
    return (await this.inner.list(this.key(prefix))).map((k) => k.slice(this.prefix.length));
  }
}

export class EnvError extends Error {}

const MAIN: EnvMeta = { id: MAIN_ENV, name: "ראשי", createdAt: "" };

// The list of environments, kept in one small file at the root of the storage.
export class EnvRegistry {
  constructor(private root: BlobDriver) {}

  private async stored(): Promise<EnvMeta[]> {
    try {
      const list = JSON.parse((await this.root.read("envs.json"))?.toString("utf8") ?? "[]");
      return Array.isArray(list) ? list.filter((e) => typeof e?.id === "string" && ENV_ID.test(e.id) && e.id !== MAIN_ENV) : [];
    } catch {
      return [];
    }
  }

  async list(): Promise<EnvMeta[]> {
    return [MAIN, ...(await this.stored())];
  }

  async get(id: string): Promise<EnvMeta | null> {
    if (id === MAIN_ENV) return MAIN;
    if (!ENV_ID.test(id)) return null;
    return (await this.stored()).find((e) => e.id === id) ?? null;
  }

  async create(input: { id: string; name: string; adminPassword: string; accessCode?: string }, now = new Date()): Promise<EnvMeta> {
    const id = input.id.trim().toLowerCase();
    const name = input.name.trim().slice(0, 80);
    if (!ENV_ID.test(id) || id === MAIN_ENV) throw new EnvError("id");
    if (!name) throw new EnvError("name");
    if (input.adminPassword.length < 8) throw new EnvError("password");
    const list = await this.stored();
    if (list.some((e) => e.id === id)) throw new EnvError("exists");
    const env: EnvMeta = { id, name, createdAt: now.toISOString(), adminHash: hashSecret(input.adminPassword), ...(input.accessCode?.trim() ? { accessHash: hashSecret(input.accessCode.trim()) } : {}) };
    await this.root.write("envs.json", Buffer.from(JSON.stringify([...list, env])));
    return env;
  }

  // `accessCode: ""` removes the code (technicians enter freely); undefined leaves it.
  async update(id: string, change: { name?: string; adminPassword?: string; accessCode?: string; disabled?: boolean }): Promise<EnvMeta> {
    const list = await this.stored();
    const env = list.find((e) => e.id === id);
    if (!env) throw new EnvError("unknown");
    if (change.name !== undefined) {
      if (!change.name.trim()) throw new EnvError("name");
      env.name = change.name.trim().slice(0, 80);
    }
    if (change.adminPassword !== undefined) {
      if (change.adminPassword.length < 8) throw new EnvError("password");
      env.adminHash = hashSecret(change.adminPassword);
    }
    if (change.accessCode !== undefined) {
      if (change.accessCode.trim()) env.accessHash = hashSecret(change.accessCode.trim());
      else delete env.accessHash;
    }
    if (change.disabled !== undefined) env.disabled = change.disabled;
    await this.root.write("envs.json", Buffer.from(JSON.stringify(list)));
    return env;
  }
}
