// Builds the meaning index of one document: a vector for every passage, stored next to it.
// The work can stop at any point (a time budget, a failed request) and continue later from
// where it stopped, so a manual of thousands of pages is indexed over a few short calls.
import type { KbStore } from "../store";
import type { DocVectors } from "../store/types";
import type { Embedder } from "./embed";

const CHUNK = 32;

export type IndexProgress = { indexed: number; total: number; done: boolean };

export async function indexDoc(store: KbStore, embedder: Embedder, kbId: string, docId: string, budgetMs = 45_000): Promise<IndexProgress> {
  const loaded = await store.getPassages(kbId, docId);
  if (!loaded) return { indexed: 0, total: 0, done: true };
  const passages = loaded.passages.filter((p) => p.text.trim());
  const stored = await store.getVectors(kbId, docId);
  // Vectors of another model are useless next to this one: start again.
  const vectors: DocVectors = stored?.model === embedder.model ? stored : { model: embedder.model, dims: 0, byN: new Map() };
  const todo = passages.filter((p) => !vectors.byN.has(p.n));
  const started = Date.now();
  let added = 0;
  try {
    for (let at = 0; at < todo.length && Date.now() - started < budgetMs; at += CHUNK) {
      const chunk = todo.slice(at, at + CHUNK);
      // The document name goes in with the text, so a page of bare numbers still says what it is about.
      const made = await embedder.embed(chunk.map((p) => `${loaded.name}\n${p.text}`), "document");
      chunk.forEach((p, i) => vectors.byN.set(p.n, made[i]));
      vectors.dims = made[0]?.length ?? vectors.dims;
      added += chunk.length;
    }
  } finally {
    // Whatever was embedded is kept, also when a later request failed.
    if (added) await store.putVectors(kbId, docId, vectors);
  }
  const indexed = passages.filter((p) => vectors.byN.has(p.n)).length;
  return { indexed, total: passages.length, done: indexed >= passages.length };
}
