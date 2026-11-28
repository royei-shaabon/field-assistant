// The knowledge base store. Everything is keyed under kbs/<kbId>/:
//   kb.json                 the knowledge base itself
//   docs/<docId>.meta.json  one document
//   docs/<docId>.text.json  its passages (what search and the model read)
//   docs/<docId>.file       the original upload (what "open the source" serves)
import path from "node:path";
import { Activity } from "./activity";
import { ENV_ID, EnvRegistry, MAIN_ENV, PrefixDriver } from "./envs";
import { FsDriver } from "./fs-driver";
import type { BlobDriver, DocMeta, DocVectors, KbMeta, Note, NoteFrom, Passage, StoredDoc, Usage } from "./types";

export type { BlobDriver, DocMeta, DocOrigin, KbMeta, Note, NoteFrom, Passage, StoredDoc, Usage } from "./types";

export const EMPTY_USAGE: Usage = { questions: 0, answer: 0, ask: 0, not_found: 0, ideas: 0, hazard: 0, error: 0, helpful: 0, unhelpful: 0 };

const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

export class NotFound extends Error {}
export class Invalid extends Error {}

// The document that holds the team's approved field notes, one note per part.
export const TEAM_DOC = "team-notes";
export const TEAM_DOC_NAME = "ידע מהצוות";
export const MAX_NOTE_CHARS = 1200;
const MAX_PENDING_NOTES = 500;
// One paragraph of plain text: no markup, bounded.
export const cleanNote = (text: unknown): string => (typeof text === "string" ? text.replace(/[<>]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_NOTE_CHARS) : "");

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

// The name a manual is shown under: what the implementer wrote, or else the uploaded file's
// name without its ending ("Rebel 500 owners manual.pdf" -> "Rebel 500 owners manual").
export const docTitle = (given: string, fileName: string): string => {
  const clean = given.replace(/\s+/g, " ").trim().slice(0, 120);
  if (clean) return clean;
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim().slice(0, 120) || fileName;
};

// Short, non-empty, at most three: they are buttons on a phone screen.
export const cleanStarters = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.replace(/\s+/g, " ").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 3);

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

  async updateKb(id: string, patch: { name?: string; description?: string; ideas?: boolean; starters?: string[] }): Promise<KbMeta> {
    const kb = await this.getKb(id);
    if (!kb) throw new NotFound("kb");
    const name = patch.name?.trim() ?? kb.name;
    if (!name || name.length > 80) throw new Invalid("name");
    const next = { ...kb, name, description: (patch.description ?? kb.description).trim().slice(0, 400), ...(patch.ideas === undefined ? {} : { ideas: patch.ideas }), ...(patch.starters === undefined ? {} : { starters: cleanStarters(patch.starters) }), updatedAt: new Date().toISOString() };
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

  // The description and model years the implementer approved. An empty text removes the field.
  async describeDoc(kbId: string, docId: string, patch: { about?: string; years?: string }): Promise<DocMeta> {
    this.checkId(kbId);
    this.checkId(docId);
    const key = `kbs/${kbId}/docs/${docId}.meta.json`;
    const meta = parse<DocMeta>(await this.driver.read(key));
    if (!meta) throw new NotFound("doc");
    const next: DocMeta = { ...meta };
    if (patch.about !== undefined) {
      if (patch.about) next.about = patch.about;
      else delete next.about;
    }
    if (patch.years !== undefined) {
      if (patch.years) next.years = patch.years;
      else delete next.years;
    }
    await this.driver.write(key, json(next));
    await this.touch(kbId); // the search index carries the years beside each source
    return next;
  }

  // What a model read from the pictures of pages: added after the page's own text. A page with
  // no text of its own becomes a passage. The vectors of these pages are dropped, because their
  // sections changed; the meaning index builds them again.
  async addSeen(kbId: string, docId: string, items: { n: number; seen: string }[]): Promise<DocMeta> {
    this.checkId(kbId);
    this.checkId(docId);
    const base = `kbs/${kbId}/docs/${docId}`;
    const meta = parse<DocMeta>(await this.driver.read(`${base}.meta.json`));
    const passages = parse<Passage[]>(await this.driver.read(`${base}.text.json`));
    if (!meta || !passages) throw new NotFound("doc");
    const byN = new Map(passages.map((p) => [p.n, p]));
    const changed: number[] = [];
    for (const { n, seen } of items) {
      if (!Number.isInteger(n) || n < 1 || n > meta.passages) continue;
      const text = seen.trim();
      const page = byN.get(n);
      if (text && page && page.own === undefined) byN.set(n, { n, text: `${page.text}\n\n${text}`, own: page.text.length });
      else if (text && !page) byN.set(n, { n, text, own: 0 });
      else continue;
      changed.push(n);
    }
    const next = [...byN.values()].sort((a, b) => a.n - b.n);
    const pictured = [...new Set([...(meta.pictured ?? []), ...items.map((i) => i.n).filter((n) => Number.isInteger(n) && n >= 1 && n <= meta.passages)])].sort((a, b) => a - b);
    const updated: DocMeta = { ...meta, pictured, empty: meta.passages - next.length, chars: next.reduce((sum, p) => sum + p.text.length, 0) };
    if (changed.length) {
      await this.driver.write(`${base}.text.json`, json(next));
      const vectors = await this.getVectors(kbId, docId);
      if (vectors) {
        const gone = new Set(changed);
        for (const key of [...vectors.byN.keys()]) if (gone.has(Math.floor(key / 1000))) vectors.byN.delete(key);
        await this.putVectors(kbId, docId, vectors);
      }
    }
    await this.driver.write(`${base}.meta.json`, json(updated));
    if (changed.length) await this.touch(kbId);
    return updated;
  }

  // Takes back everything that was read from pictures: every page is again only the file's own
  // text, and waits to be read again (after the reading was improved).
  async clearSeen(kbId: string, docId: string): Promise<DocMeta> {
    this.checkId(kbId);
    this.checkId(docId);
    const base = `kbs/${kbId}/docs/${docId}`;
    const meta = parse<DocMeta>(await this.driver.read(`${base}.meta.json`));
    const passages = parse<Passage[]>(await this.driver.read(`${base}.text.json`));
    if (!meta || !passages) throw new NotFound("doc");
    const changed = passages.filter((p) => p.own !== undefined).map((p) => p.n);
    const next = passages.flatMap((p): Passage[] => (p.own === undefined ? [p] : p.own > 0 ? [{ n: p.n, text: p.text.slice(0, p.own) }] : []));
    const updated: DocMeta = { ...meta, empty: meta.passages - next.length, chars: next.reduce((sum, p) => sum + p.text.length, 0) };
    delete updated.pictured;
    await this.driver.write(`${base}.text.json`, json(next));
    const vectors = await this.getVectors(kbId, docId);
    if (vectors && changed.length) {
      const gone = new Set(changed);
      for (const key of [...vectors.byN.keys()]) if (gone.has(Math.floor(key / 1000))) vectors.byN.delete(key);
      await this.putVectors(kbId, docId, vectors);
    }
    await this.driver.write(`${base}.meta.json`, json(updated));
    await this.touch(kbId);
    return updated;
  }

  // --- field notes: what the team learned, approved by the implementer ----------------------

  async listNotes(kbId: string): Promise<Note[]> {
    this.checkId(kbId);
    const keys = (await this.driver.list(`kbs/${kbId}/notes/`)).filter((k) => k.endsWith(".json"));
    const all = await Promise.all(keys.map(async (k) => parse<Note>(await this.driver.read(k))));
    return all.filter((n): n is Note => Boolean(n)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // A new note waits for the implementer. The implementer's own note may be approved at once.
  async addNote(kbId: string, input: { text: string; from: NoteFrom; approve?: boolean }): Promise<Note> {
    if (!(await this.getKb(kbId))) throw new NotFound("kb");
    const text = cleanNote(input.text);
    if (text.length < 10) throw new Invalid("text");
    const all = await this.listNotes(kbId);
    if (all.filter((n) => n.status === "pending").length >= MAX_PENDING_NOTES) throw new Invalid("full");
    // The same words again add nothing.
    const same = all.find((n) => n.text === text && n.status !== "rejected");
    if (same) return same;
    const note: Note = { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kbId, text, from: input.from, status: "pending", createdAt: new Date().toISOString() };
    await this.driver.write(`kbs/${kbId}/notes/${note.id}.json`, json(note));
    return input.approve ? this.decideNote(kbId, note.id, { status: "approved" }) : note;
  }

  // The implementer approves, rejects or corrects a note. Approved notes are the team's document.
  async decideNote(kbId: string, id: string, patch: { status?: Note["status"]; text?: string }): Promise<Note> {
    this.checkId(kbId);
    this.checkId(id);
    const key = `kbs/${kbId}/notes/${id}.json`;
    const note = parse<Note>(await this.driver.read(key));
    if (!note) throw new NotFound("note");
    const text = patch.text === undefined ? note.text : cleanNote(patch.text);
    if (text.length < 10) throw new Invalid("text");
    const status = patch.status ?? note.status;
    const all = await this.listNotes(kbId);
    const n = status === "approved" ? (note.n ?? Math.max(0, ...all.map((x) => x.n ?? 0)) + 1) : note.n;
    const next: Note = { ...note, text, status, ...(n ? { n } : {}), decidedAt: new Date().toISOString() };
    await this.driver.write(key, json(next));
    if (status === "approved" || note.status === "approved") await this.rebuildTeamDoc(kbId, note.n !== undefined && text !== note.text ? [note.n] : []);
    return next;
  }

  // Writes the team's document from the approved notes: each note is a part, under its own number.
  private async rebuildTeamDoc(kbId: string, changed: number[]): Promise<void> {
    const approved = (await this.listNotes(kbId)).filter((n) => n.status === "approved" && n.n).sort((a, b) => a.n! - b.n!);
    const base = `kbs/${kbId}/docs/${TEAM_DOC}`;
    if (!approved.length) {
      await this.deleteDoc(kbId, TEAM_DOC);
      return;
    }
    const passages: Passage[] = approved.map((n) => ({ n: n.n!, text: n.text }));
    const file = Buffer.from(approved.map((n) => `${n.n}. ${n.text}`).join("\n\n"), "utf8");
    const before = parse<DocMeta>(await this.driver.read(`${base}.meta.json`));
    const meta: DocMeta = {
      id: TEAM_DOC,
      kbId,
      name: before?.name ?? TEAM_DOC_NAME,
      ...(before?.about ? { about: before.about } : {}),
      origin: "team",
      unit: "part",
      mime: "text/plain; charset=utf-8",
      ext: ".txt",
      bytes: file.length,
      passages: Math.max(...passages.map((p) => p.n)),
      empty: 0,
      chars: passages.reduce((sum, p) => sum + p.text.length, 0),
      uploadedAt: before?.uploadedAt ?? new Date().toISOString(),
    };
    await this.driver.write(`${base}.file`, file);
    await this.driver.write(`${base}.text.json`, json(passages));
    // A note whose words changed: its old vectors describe the old words.
    const vectors = changed.length ? await this.getVectors(kbId, TEAM_DOC) : null;
    if (vectors) {
      const gone = new Set(changed);
      for (const k of [...vectors.byN.keys()]) if (gone.has(Math.floor(k / 1000))) vectors.byN.delete(k);
      await this.putVectors(kbId, TEAM_DOC, vectors);
    }
    await this.driver.write(`${base}.meta.json`, json(meta));
    await this.touch(kbId);
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
