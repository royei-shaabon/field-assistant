// The knowledge base store. Everything is keyed under kbs/<kbId>/:
//   kb.json                 the knowledge base itself
//   docs/<docId>.meta.json  one document
//   docs/<docId>.text.json  its passages (what search and the model read)
//   docs/<docId>.file       the original upload (what "open the source" serves)
import path from "node:path";
import { Activity } from "./activity";
import { ENV_ID, EnvRegistry, MAIN_ENV, PrefixDriver } from "./envs";
import { FsDriver } from "./fs-driver";
import type { BlobDriver, DocMeta, DocVectors, KbMeta, Passage, StoredDoc, Usage } from "./types";

export type { BlobDriver, DocMeta, DocOrigin, KbMeta, Passage, StoredDoc, Usage } from "./types";

export const EMPTY_USAGE: Usage = { questions: 0, answer: 0, ask: 0, not_found: 0, ideas: 0, hazard: 0, error: 0, helpful: 0, unhelpful: 0 };

const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

export class NotFound extends Error {}
export class Invalid extends Error {}

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
// A damaged file reads as missing, so one bad write cannot take the admin screen down.
const parse = <T>(b: Buffer | null): T | null => {
  if (!b) return null;
  try {
    return JSON.parse(b.toString("utf8")) as T;
  } catch {
    return null;
  }
};

export function slug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii.length >= 2 ? ascii : `kb-${Date.now().toString(36)}`;
}

// `language`: the language of this environment's calls (he, en, ru, ar).
export type Settings = { voice?: string; liveVoice?: string; language?: string };

export class KbStore {
  constructor(private driver: BlobDriver) {}

  private checkId(id: string) {
    if (!ID.test(id)) throw new Invalid("bad id");
  }

  async listKbs(): Promise<KbMeta[]> {
    const keys = (await this.driver.list("kbs")).filter((k) => /^kbs\/[^/]+\/kb\.json$/.test(k));
    const all = await Promise.all(keys.map(async (k) => parse<KbMeta>(await this.driver.read(k))));
    return all.filter((k): k is KbMeta => Boolean(k)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getKb(id: string): Promise<KbMeta | null> {
    if (!ID.test(id)) return null;
    return parse<KbMeta>(await this.driver.read(`kbs/${id}/kb.json`));
  }

  async createKb(input: { id?: string; name: string; description?: string }): Promise<KbMeta> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Invalid("name");
    let id = input.id ?? slug(name);
    this.checkId(id);
    for (let n = 2; await this.getKb(id); n++) id = `${input.id ?? slug(name)}-${n}`;
    const now = new Date().toISOString();
    const kb: KbMeta = { id, name, description: (input.description ?? "").trim().slice(0, 400), createdAt: now, updatedAt: now };
    await this.driver.write(`kbs/${id}/kb.json`, json(kb));
    return kb;
  }

  async updateKb(id: string, patch: { name?: string; description?: string; ideas?: boolean }): Promise<KbMeta> {
    const kb = await this.getKb(id);
    if (!kb) throw new NotFound("kb");
    const name = patch.name?.trim() ?? kb.name;
    if (!name || name.length > 80) throw new Invalid("name");
    const next = { ...kb, name, description: (patch.description ?? kb.description).trim().slice(0, 400), ...(patch.ideas === undefined ? {} : { ideas: patch.ideas }), updatedAt: new Date().toISOString() };
    await this.driver.write(`kbs/${id}/kb.json`, json(next));
    return next;
  }

  async deleteKb(id: string): Promise<void> {
    this.checkId(id);
    await this.driver.remove(`kbs/${id}`);
  }

  private async touch(kbId: string): Promise<void> {
    const kb = await this.getKb(kbId);
    if (kb) await this.driver.write(`kbs/${kbId}/kb.json`, json({ ...kb, updatedAt: new Date().toISOString() }));
  }

  async listDocs(kbId: string): Promise<DocMeta[]> {
    this.checkId(kbId);
    const keys = (await this.driver.list(`kbs/${kbId}/docs`)).filter((k) => k.endsWith(".meta.json"));
    const all = await Promise.all(keys.map(async (k) => parse<DocMeta>(await this.driver.read(k))));
    return all.filter((d): d is DocMeta => Boolean(d)).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  }

  async addDoc(kbId: string, doc: Omit<DocMeta, "id" | "kbId" | "uploadedAt">, passages: Passage[], file: Buffer): Promise<DocMeta> {
    if (!(await this.getKb(kbId))) throw new NotFound("kb");
    const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const meta: DocMeta = { ...doc, id, kbId, uploadedAt: new Date().toISOString() };
    const base = `kbs/${kbId}/docs/${id}`;
    await this.driver.write(`${base}.file`, file);
    await this.driver.write(`${base}.text.json`, json(passages));
    await this.driver.write(`${base}.meta.json`, json(meta)); // last: a document exists once its meta does
    await this.touch(kbId);
    return meta;
  }

  // The name is what technicians see on every source chip, so the implementer can fix it.
  async renameDoc(kbId: string, docId: string, name: string): Promise<DocMeta> {
    this.checkId(kbId);
    this.checkId(docId);
    const clean = name.trim().slice(0, 120);
    if (!clean) throw new Invalid("name");
    const key = `kbs/${kbId}/docs/${docId}.meta.json`;
    const meta = parse<DocMeta>(await this.driver.read(key));
    if (!meta) throw new NotFound("doc");
    const next = { ...meta, name: clean };
    await this.driver.write(key, json(next));
    await this.touch(kbId); // rebuilds the search index, which carries the name
    return next;
  }

  async deleteDoc(kbId: string, docId: string): Promise<void> {
    this.checkId(kbId);
    this.checkId(docId);
    const base = `kbs/${kbId}/docs/${docId}`;
    await Promise.all([".meta.json", ".text.json", ".file", ".vec.json", ".vec.bin"].map((s) => this.driver.remove(base + s)));
    await this.driver.remove(`kbs/${kbId}/pages/${docId}`);
    await this.touch(kbId);
  }

  async getDocFile(kbId: string, docId: string): Promise<{ meta: DocMeta; data: Buffer } | null> {
    if (!ID.test(kbId) || !ID.test(docId)) return null;
    const base = `kbs/${kbId}/docs/${docId}`;
    const meta = parse<DocMeta>(await this.driver.read(`${base}.meta.json`));
    const data = await this.driver.read(`${base}.file`);
    return meta && data ? { meta, data } : null;
  }

  // Rendered page pictures, kept next to the document they come from.
  async getPageImage(kbId: string, docId: string, n: number): Promise<Buffer | null> {
    this.checkId(kbId);
    this.checkId(docId);
    return this.driver.read(`kbs/${kbId}/pages/${docId}/${n}.png`);
  }

  async putPageImage(kbId: string, docId: string, n: number, png: Buffer): Promise<void> {
    this.checkId(kbId);
    this.checkId(docId);
    await this.driver.write(`kbs/${kbId}/pages/${docId}/${n}.png`, png);
  }

  async getUsage(kbId: string): Promise<Usage> {
    this.checkId(kbId);
    return { ...EMPTY_USAGE, ...(parse<Usage>(await this.driver.read(`kbs/${kbId}/usage.json`)) ?? {}) };
  }

  // Counts one reply. Read-modify-write: two replies at the same instant may count as one,
  // which is fine for a usage overview.
  async recordUsage(kbId: string, kind: "answer" | "ask" | "not_found" | "ideas" | "hazard" | "error"): Promise<void> {
    const usage = await this.getUsage(kbId);
    const next: Usage = { ...usage, questions: usage.questions + 1, [kind]: usage[kind] + 1, lastAt: new Date().toISOString() };
    await this.driver.write(`kbs/${kbId}/usage.json`, json(next));
  }

  // "Helped" / "did not help" on an answer: a count only, never the question or the answer.
  async recordFeedback(kbId: string, helpful: boolean): Promise<void> {
    if (!(await this.getKb(kbId))) throw new NotFound("kb");
    const usage = await this.getUsage(kbId);
    const field = helpful ? "helpful" : "unhelpful";
    await this.driver.write(`kbs/${kbId}/usage.json`, json({ ...usage, [field]: usage[field] + 1 }));
  }

  async getPassages(kbId: string, docId: string): Promise<{ name: string; passages: Passage[] } | null> {
    this.checkId(kbId);
    this.checkId(docId);
    const base = `kbs/${kbId}/docs/${docId}`;
    const meta = parse<DocMeta>(await this.driver.read(`${base}.meta.json`));
    const passages = parse<Passage[]>(await this.driver.read(`${base}.text.json`));
    return meta && passages ? { name: meta.name, passages } : null;
  }

  // The meaning index of a document: a small JSON header and the vectors as raw 32-bit floats.
  async vectorInfo(kbId: string, docId: string): Promise<{ model: string; count: number } | null> {
    this.checkId(kbId);
    this.checkId(docId);
    const head = parse<{ model: string; dims: number; ns: number[] }>(await this.driver.read(`kbs/${kbId}/docs/${docId}.vec.json`));
    return head ? { model: head.model, count: head.ns.length } : null;
  }

  async getVectors(kbId: string, docId: string): Promise<DocVectors | null> {
    this.checkId(kbId);
    this.checkId(docId);
    const base = `kbs/${kbId}/docs/${docId}`;
    const head = parse<{ model: string; dims: number; ns: number[] }>(await this.driver.read(`${base}.vec.json`));
    const bin = head && (await this.driver.read(`${base}.vec.bin`));
    if (!head || !bin || !(head.dims > 0) || bin.byteLength !== head.ns.length * head.dims * 4) return null;
    const copy = new Uint8Array(bin.byteLength);
    copy.set(bin);
    const all = new Float32Array(copy.buffer);
    return { model: head.model, dims: head.dims, byN: new Map(head.ns.map((n, i) => [n, all.subarray(i * head.dims, (i + 1) * head.dims)])) };
  }

  async putVectors(kbId: string, docId: string, vectors: DocVectors): Promise<void> {
    this.checkId(kbId);
    this.checkId(docId);
    const base = `kbs/${kbId}/docs/${docId}`;
    if (!(await this.driver.read(`${base}.meta.json`))) throw new NotFound("doc");
    const ns = [...vectors.byN.keys()].sort((a, b) => a - b);
    const all = new Float32Array(ns.length * vectors.dims);
    ns.forEach((n, i) => all.set(vectors.byN.get(n)!, i * vectors.dims));
    await this.driver.write(`${base}.vec.bin`, Buffer.from(all.buffer));
    await this.driver.write(`${base}.vec.json`, json({ model: vectors.model, dims: vectors.dims, ns }));
    await this.touch(kbId); // rebuilds the search index, which holds the vectors
  }

  // Service-wide settings the implementer changes in /admin (today: the voice of the assistant).
  // `voice`: the classic call's voice. `liveVoice`: the live call's voice.
  async getSettings(): Promise<Settings> {
    return parse<Settings>(await this.driver.read("settings.json")) ?? {};
  }

  async putSettings(settings: Settings): Promise<void> {
    await this.driver.write("settings.json", json(settings));
  }

  // Spoken lines are kept, so the same sentence is synthesised once per voice.
  // A voice name is "<provider>:<voice>"; the colon becomes "__" in the folder name.
  async getAudio(voice: string, hash: string): Promise<Buffer | null> {
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(voice) || !/^[a-f0-9]{64}$/.test(hash)) return null;
    return this.driver.read(`tts/${voice.replace(/:/g, "__")}/${hash}.mp3`);
  }

  async putAudio(voice: string, hash: string, audio: Buffer): Promise<void> {
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(voice) || !/^[a-f0-9]{64}$/.test(hash)) throw new Invalid("audio key");
    await this.driver.write(`tts/${voice.replace(/:/g, "__")}/${hash}.mp3`, audio);
  }

  // Every document with its passages and its meaning index: what the search index is built from.
  async loadDocs(kbId: string): Promise<StoredDoc[]> {
    const metas = await this.listDocs(kbId);
    return Promise.all(
      metas.map(async (meta) => {
        const vectors = await this.getVectors(kbId, meta.id);
        return { meta, passages: parse<Passage[]>(await this.driver.read(`kbs/${kbId}/docs/${meta.id}.text.json`)) ?? [], ...(vectors ? { vectors } : {}) };
      }),
    );
  }
}

const rootDriver = (() => {
  let driver: BlobDriver | undefined;
  // DATA_DIR points at a persistent directory in a hosted deployment. Default: ./data.
  return () => (driver ??= new FsDriver(path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? "data")));
})();

// What one environment sees of the storage. "main" is the root itself (where the data lived
// before there were environments); every other environment lives under envs/<id>/.
export function envDriver(envId: string = MAIN_ENV): BlobDriver {
  if (envId === MAIN_ENV) return rootDriver();
  if (!ENV_ID.test(envId)) throw new Invalid("environment");
  return new PrefixDriver(rootDriver(), `envs/${envId}/`);
}

const stores = new Map<string, KbStore>();

// The knowledge bases, settings and usage of one environment.
export function kbStore(envId: string = MAIN_ENV): KbStore {
  let store = stores.get(envId);
  if (!store) stores.set(envId, (store = new KbStore(envDriver(envId))));
  return store;
}

// The conversation log and the daily numbers of one environment.
export const activity = (envId: string = MAIN_ENV) => new Activity(envDriver(envId), envId);

export const envRegistry = () => new EnvRegistry(rootDriver());
