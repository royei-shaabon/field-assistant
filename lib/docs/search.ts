// Search over the passages of one knowledge base, two ways: by keywords (BM25), where the model
// writes the queries in the language of the documents, and by meaning (vectors), when the
// documents have a meaning index. The two are combined in lib/docs/agent-tools.ts.
import { span } from "../server/log";
import { sectionKey, sectionsInContext } from "./chunk";
import type { StoredDoc } from "../store/types";

export type Hit = {
  // Stable reference the model cites and the code verifies, e.g. "d1x2y3:52".
  ref: string;
  docId: string;
  docName: string;
  // The model years the document covers, when the implementer stated them.
  years?: string;
  origin: StoredDoc["meta"]["origin"];
  unit: StoredDoc["meta"]["unit"];
  n: number;
  // The whole page (or part): what answers cite and quotes are checked against.
  text: string;
  // The section of the page that matched best: what the question is about.
  focus?: string;
  score: number;
};

const STOP = new Set(
  "a an and are as at be by for from has have how i if in into is it its of on or that the their this to was what when where which who why will with you your do does can should my".split(" "),
);

// Light stemming: enough to match "brakes"/"brake", "checking"/"check", and Hebrew one-letter
// prefixes ("המנוע"/"מנוע").
function stem(word: string): string {
  if (/^[a-z]/.test(word)) {
    if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
    if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
  }
  if (/^[֐-׿]/.test(word) && word.length > 3 && /^[והבלמשכ]/.test(word)) return word.slice(1);
  return word;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

// One section of a page. Search scores sections; results are given per page, with the best
// section as its `focus`.
type Entry = { hit: Omit<Hit, "score" | "focus">; section: string; tf: Map<string, number>; length: number; vec?: Float32Array; model?: string };

export class SearchIndex {
  private entries: Entry[] = [];
  private pages = new Map<string, Omit<Hit, "score" | "focus">>();
  private df = new Map<string, number>();
  private avgLength = 1;
  private languages = new Map<string, "Hebrew" | "English" | "other">();

  constructor(docs: StoredDoc[]) {
    for (const { meta, passages, vectors } of docs) {
      // The language of a document, from a sample of its text: queries must be written in it.
      const sample = passages.slice(0, 40).map((p) => p.text).join(" ").slice(0, 20_000);
      const hebrew = (sample.match(/[\u0590-\u05ff]/g) ?? []).length;
      const latin = (sample.match(/[a-z]/gi) ?? []).length;
      this.languages.set(meta.id, hebrew > latin ? "Hebrew" : latin > 0 ? "English" : "other");
      for (const p of passages) {
        const hit = { ref: `${meta.id}:${p.n}`, docId: meta.id, docName: meta.name, ...(meta.years ? { years: meta.years } : {}), origin: meta.origin, unit: meta.unit, n: p.n, text: p.text };
        this.pages.set(hit.ref, hit);
        sectionsInContext(p.text).forEach(({ text: section, context }, c) => {
          // The headings a section stands under are searched with it.
          const words = tokens(context ? `${context}\n${section}` : section);
          const tf = new Map<string, number>();
          for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
          for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
          const vec = vectors?.byN.get(sectionKey(p.n, c));
          this.entries.push({ hit, section, tf, length: words.length, ...(vec ? { vec, model: vectors!.model } : {}) });
        });
      }
    }
    this.avgLength = this.entries.reduce((n, e) => n + e.length, 0) / Math.max(1, this.entries.length);
  }

  language(docId: string): string {
    return this.languages.get(docId) ?? "other";
  }

  get sectionCount(): number {
    return this.entries.length;
  }

  get vectorCount(): number {
    return this.entries.filter((e) => e.vec).length;
  }

  // How many pages (or parts) can be searched.
  get size(): number {
    return this.pages.size;
  }

  get(ref: string): Omit<Hit, "score" | "focus"> | undefined {
    return this.pages.get(ref);
  }

  // The sections of one page, in their order.
  sectionsOf(ref: string): string[] {
    return this.entries.filter((e) => e.hit.ref === ref).map((e) => e.section);
  }

  // Scored sections become page results: each page once, with its best section as the focus.
  private byPage(scored: { entry: Entry; score: number }[], limit: number): Hit[] {
    const best = new Map<string, Hit>();
    for (const { entry, score } of scored.sort((a, b) => b.score - a.score)) {
      if (best.has(entry.hit.ref)) continue;
      best.set(entry.hit.ref, { ...entry.hit, focus: entry.section, score });
      if (best.size >= limit) break;
    }
    return [...best.values()];
  }

  // True when some passages can be searched by meaning with this embedding model.
  hasVectors(model: string): boolean {
    return this.entries.some((e) => e.model === model);
  }

  // The pages whose sections are closest in meaning to the query vector. Vectors are unit length, so the dot
  // product is the cosine similarity.
  semantic(query: Float32Array, model: string, limit = 5): Hit[] {
    const scored: { entry: Entry; score: number }[] = [];
    for (const e of this.entries) {
      if (e.model !== model || !e.vec || e.vec.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += e.vec[i] * query[i];
      if (dot > 0) scored.push({ entry: e, score: dot });
    }
    return this.byPage(scored, limit);
  }

  search(query: string, limit = 5): Hit[] {
    const terms = [...new Set(tokens(query))];
    const N = this.entries.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored: { entry: Entry; score: number }[] = [];
    for (const e of this.entries) {
      let score = 0;
      for (const t of terms) {
        const f = e.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t)!;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.length) / this.avgLength));
      }
      if (score > 0) scored.push({ entry: e, score });
    }
    return this.byPage(scored, limit);
  }
}

// One index per knowledge base, rebuilt when the knowledge base changes.
const cache = new Map<string, { version: string; index: SearchIndex }>();

export function cachedIndex(kbId: string, version: string, load: () => Promise<StoredDoc[]>): Promise<SearchIndex> {
  const hit = cache.get(kbId);
  if (hit && hit.version === version) return Promise.resolve(hit.index);
  // Built on the first question after the knowledge base changed (or after the server
  // started): reading every document, then cutting and counting every section.
  const stage = span("index.build", { kb: kbId });
  return load().then(
    (docs) => {
      stage.part("read");
      const index = new SearchIndex(docs);
      stage.part("build");
      cache.set(kbId, { version, index });
      stage.end({ docs: docs.length, pages: index.size, sections: index.sectionCount, vectors: index.vectorCount });
      return index;
    },
    (e) => {
      stage.fail(e);
      throw e;
    },
  );
}
