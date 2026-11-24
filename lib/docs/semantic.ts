// Builds the meaning index of one document: a vector for every section of every page, stored
// next to the document. The work can stop at any point (a time budget, a failed request) and
// continue later from where it stopped, so a manual of thousands of pages is indexed over a
// few short calls.
import type { KbStore } from "../store";
import type { DocVectors, Passage } from "../store/types";
import { sectionKey, sectionsInContext, vectorModel } from "./chunk";
import type { Embedder } from "./embed";

const BATCH = 32;
// Embedding requests sent at the same time (EMBED_PARALLEL). One for a service with a tight quota.
const PARALLEL = () => Math.min(8, Math.max(1, Number(process.env.EMBED_PARALLEL) || 4));

export type IndexProgress = { indexed: number; total: number; done: boolean };
// Filled by `indexDoc` for the stage log: milliseconds per part, and how many embedding calls.
export type IndexTiming = { load: number; embed: number; store: number; batches: number; sections: number };

// Every section of a document with the number its vector is stored under.
export function sectionList(passages: Passage[]): { key: number; text: string }[] {
  // The text that is embedded is the section under its headings; see sectionsInContext.
  return passages.flatMap((p) => sectionsInContext(p.text).map(({ text, context }, c) => ({ key: sectionKey(p.n, c), text: context ? `${context}\n${text}` : text })));
}

export async function indexDoc(store: KbStore, embedder: Embedder, kbId: string, docId: string, budgetMs = 45_000, timing?: IndexTiming): Promise<IndexProgress> {
  const began = Date.now();
  const loaded = await store.getPassages(kbId, docId);
  if (!loaded) return { indexed: 0, total: 0, done: true };
  const all = sectionList(loaded.passages);
  const model = vectorModel(embedder.model);
  const stored = await store.getVectors(kbId, docId);
  // Vectors of another model, or of pages cut another way, are useless next to these: start again.
  const vectors: DocVectors = stored?.model === model ? stored : { model, dims: 0, byN: new Map() };
  const todo = all.filter((s) => !vectors.byN.has(s.key));
  const started = Date.now();
  if (timing) timing.load = started - began;
  let added = 0;
  try {
    // Several requests at a time: a manual of thousands of pages is thousands of sections, and
    // one request after another would take minutes. What succeeded is kept when one fails.
    const wave = BATCH * PARALLEL();
    for (let at = 0; at < todo.length && Date.now() - started < budgetMs; at += wave) {
      const batches = Array.from({ length: Math.ceil(Math.min(wave, todo.length - at) / BATCH) }, (_, i) => todo.slice(at + i * BATCH, at + (i + 1) * BATCH));
      const calling = Date.now();
      // The document name goes in with the text, so a section of bare numbers still says what it is about.
      const results = await Promise.allSettled(batches.map((batch) => embedder.embed(batch.map((s) => `${loaded.name}\n${s.text}`), "document")));
      if (timing) timing.embed += Date.now() - calling;
      results.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        batches[i].forEach((s, j) => vectors.byN.set(s.key, result.value[j]));
        vectors.dims = result.value[0]?.length ?? vectors.dims;
        added += batches[i].length;
        if (timing) {
          timing.batches++;
          timing.sections += batches[i].length;
        }
      });
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  } finally {
    // Whatever was embedded is kept, also when a later request failed.
    const storing = Date.now();
    if (added) await store.putVectors(kbId, docId, vectors);
    if (timing) timing.store = Date.now() - storing;
  }
  const indexed = all.filter((s) => vectors.byN.has(s.key)).length;
  return { indexed, total: all.length, done: indexed >= all.length };
}
