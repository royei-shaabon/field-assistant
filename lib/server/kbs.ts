// Server-side access to knowledge bases: the document ones from the store, plus the built-in
// sample of curated fault trees (knowledge/), which shows the platform running a second,
// different knowledge base.
import { cachedIndex, type SearchIndex } from "../docs/search";
import { kbStore, type DocMeta, type KbMeta } from "../store";

export const SAMPLE_KB_ID = "sample-fault-trees";

export type KbSummary = { id: string; name: string; description: string; kind: "documents" | "trees"; documents: number };

const SEED = {
  id: "honda-rebel-500-2024",
  name: "Honda Rebel 500 (2024)",
  description: "מדריך הבעלים של היצרן ומסמכי הלקוח.",
};

let seeded: Promise<void> | undefined;

// A fresh deployment starts with one empty knowledge base, ready for the first upload.
export function ensureSeed(): Promise<void> {
  seeded ??= (async () => {
    const store = kbStore();
    if ((await store.listKbs()).length === 0) await store.createKb(SEED);
  })().catch((e) => {
    seeded = undefined;
    throw e;
  });
  return seeded;
}

export const sampleKbVisible = () => process.env.HIDE_SAMPLE_KB !== "1";

export async function listKbSummaries(): Promise<KbSummary[]> {
  await ensureSeed();
  const store = kbStore();
  const kbs = await store.listKbs();
  const out: KbSummary[] = await Promise.all(
    kbs.map(async (k) => ({ id: k.id, name: k.name, description: k.description, kind: "documents" as const, documents: (await store.listDocs(k.id)).length })),
  );
  if (sampleKbVisible()) {
    out.push({ id: SAMPLE_KB_ID, name: "דוגמה: עצי תקלות (NMAX 155)", description: "מאגר לדוגמה של מסלולי אבחון מאושרים. תוכן SAMPLE.", kind: "trees", documents: 0 });
  }
  return out;
}

export type LoadedDocKb = { meta: KbMeta; docs: DocMeta[]; index: SearchIndex };

export async function loadDocKb(kbId: string): Promise<LoadedDocKb | null> {
  await ensureSeed();
  const store = kbStore();
  const meta = await store.getKb(kbId);
  if (!meta) return null;
  const docs = await store.listDocs(kbId);
  const index = await cachedIndex(kbId, meta.updatedAt, () => store.loadDocs(kbId));
  return { meta, docs, index };
}

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
