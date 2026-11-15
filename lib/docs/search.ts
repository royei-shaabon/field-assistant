// Keyword search (BM25) over the passages of one knowledge base. The model writes the queries
// in the language of the documents, so a Hebrew question can find an English manual page.
import type { StoredDoc } from "../store/types";

export type Hit = {
  // Stable reference the model cites and the code verifies, e.g. "d1x2y3:52".
  ref: string;
  docId: string;
  docName: string;
  origin: StoredDoc["meta"]["origin"];
  unit: StoredDoc["meta"]["unit"];
  n: number;
  text: string;
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

type Entry = { hit: Omit<Hit, "score">; tf: Map<string, number>; length: number };

export class SearchIndex {
  private entries: Entry[] = [];
  private df = new Map<string, number>();
  private avgLength = 1;

  constructor(docs: StoredDoc[]) {
    for (const { meta, passages } of docs) {
      for (const p of passages) {
        const words = tokens(p.text);
        const tf = new Map<string, number>();
        for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
        for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
        this.entries.push({
          hit: { ref: `${meta.id}:${p.n}`, docId: meta.id, docName: meta.name, origin: meta.origin, unit: meta.unit, n: p.n, text: p.text },
          tf,
          length: words.length,
        });
      }
    }
    this.avgLength = this.entries.reduce((n, e) => n + e.length, 0) / Math.max(1, this.entries.length);
  }

  get size(): number {
    return this.entries.length;
  }

  get(ref: string): Omit<Hit, "score"> | undefined {
    return this.entries.find((e) => e.hit.ref === ref)?.hit;
  }

  search(query: string, limit = 5): Hit[] {
    const terms = [...new Set(tokens(query))];
    const N = this.entries.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored: Hit[] = [];
    for (const e of this.entries) {
      let score = 0;
      for (const t of terms) {
        const f = e.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t)!;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.length) / this.avgLength));
      }
      if (score > 0) scored.push({ ...e.hit, score });
    }
    return scored.sort((a, b2) => b2.score - a.score).slice(0, limit);
  }
}

// One index per knowledge base, rebuilt when the knowledge base changes.
const cache = new Map<string, { version: string; index: SearchIndex }>();

export function cachedIndex(kbId: string, version: string, load: () => Promise<StoredDoc[]>): Promise<SearchIndex> {
  const hit = cache.get(kbId);
  if (hit && hit.version === version) return Promise.resolve(hit.index);
  return load().then((docs) => {
    const index = new SearchIndex(docs);
    cache.set(kbId, { version, index });
    return index;
  });
}
