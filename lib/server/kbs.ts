// Server-side access to knowledge bases: the document ones from the store, plus the built-in
// sample of curated fault trees (knowledge/), which shows the platform running a second,
// different knowledge base.
import { cachedIndex, type SearchIndex } from "../docs/search";
import { kbStore, type DocMeta, type KbMeta } from "../store";
import { currentEnvId, MAIN_ENV } from "./env";

export const SAMPLE_KB_ID = "sample-fault-trees";

export type KbSummary = { id: string; name: string; description: string; kind: "documents" | "trees"; documents: number; starters?: string[] };

const SEED = {
  id: "honda-rebel-500-2024",
  name: "Honda Rebel 500 (2024)",
  description: "מדריך הבעלים של היצרן ומסמכי הלקוח.",
};

let seeded: Promise<void> | undefined;

// A fresh deployment starts with one empty knowledge base in the main environment, ready for
// the first upload. Other environments start empty.
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

// The knowledge bases of this request's environment. The sample of fault trees belongs to
// the main environment only.
export async function listKbSummaries(): Promise<KbSummary[]> {
  const envId = await currentEnvId();
  if (envId === MAIN_ENV) await ensureSeed();
  const store = kbStore(envId);
  const kbs = await store.listKbs();
  const out: KbSummary[] = await Promise.all(
    kbs.map(async (k) => ({ id: k.id, name: k.name, description: k.description, kind: "documents" as const, documents: (await store.listDocs(k.id)).length, ...(k.starters?.length ? { starters: k.starters } : {}) })),
  );
  if (envId === MAIN_ENV && sampleKbVisible()) {
    out.push({ id: SAMPLE_KB_ID, name: "דוגמה: עצי תקלות (NMAX 155)", description: "מאגר לדוגמה של מסלולי אבחון מאושרים. תוכן SAMPLE.", kind: "trees", documents: 0 });
  }
  return out;
}

export type LoadedDocKb = { meta: KbMeta; docs: DocMeta[]; index: SearchIndex };

export async function loadDocKb(kbId: string): Promise<LoadedDocKb | null> {
  const envId = await currentEnvId();
  if (envId === MAIN_ENV) await ensureSeed();
  const store = kbStore(envId);
  const meta = await store.getKb(kbId);
  if (!meta) return null;
  const docs = await store.listDocs(kbId);
  // Two environments may name a knowledge base the same: the index is kept per environment.
  const index = await cachedIndex(`${envId}/${kbId}`, meta.updatedAt, () => store.loadDocs(kbId));
  return { meta, docs, index };
}

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
