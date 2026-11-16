// The only things the agent can do. The model has no abilities of its own: it can ask for a
// skill by name, and the code here decides whether that skill exists and runs it.
// A skill is declared in skills/agent/<name>/skill.json (what the model is told, and its
// access level) and implemented below. Every skill is read-only: nothing here can write to a
// knowledge base, reach the network, or act outside the knowledge base the technician is in.
import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../llm";
import type { Embedder } from "./embed";
import type { Hit, SearchIndex } from "./search";

const PER_QUERY = 4;
const PER_SEARCH = 8;

export type SkillContext = { index: SearchIndex; seen: Map<string, Hit>; embedder?: Embedder | null };
export type SkillOutcome = { hits: Hit[]; note?: string; label?: string };
type Handler = (ctx: SkillContext, input: unknown) => SkillOutcome | Promise<SkillOutcome>;

function keywordSearch(index: SearchIndex, queries: string[]): Hit[] {
  const merged = new Map<string, Hit>();
  for (const q of queries) for (const h of index.search(q, PER_QUERY)) if (!merged.has(h.ref) || merged.get(h.ref)!.score < h.score) merged.set(h.ref, h);
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, PER_SEARCH);
}

// Hybrid search. Every query is searched by keywords and, when the knowledge base has a
// meaning index, by meaning; `also` (the technician's own words, in any language) is searched
// by meaning only. The ranked lists are fused by reciprocal rank: a passage that several lists
// put near the top comes first. With no meaning index, or when the embedding service fails,
// this is the keyword search alone.
const RRF = 60;
export type SearchOptions = {
  embedder?: Embedder | null;
  also?: string;
  // The vector of `also`, when the caller already asked for it (so it could run alongside other work).
  alsoVector?: Promise<Float32Array | null>;
  // False: the queries are searched by keywords only, and only `also` is searched by meaning.
  embedQueries?: boolean;
};

export async function runSearch(index: SearchIndex, queries: string[], opts: SearchOptions = {}): Promise<Hit[]> {
  const embedder = opts.embedder;
  if (!embedder || !index.hasVectors(embedder.model)) return keywordSearch(index, queries);
  const also = opts.also?.trim();
  const texts = [...(opts.embedQueries === false ? [] : queries), ...(also && !opts.alsoVector ? [also] : [])];
  if (!texts.length && !opts.alsoVector) return keywordSearch(index, queries);
  let vectors: Float32Array[];
  try {
    vectors = texts.length ? await embedder.embed(texts, "query") : [];
    const ready = await opts.alsoVector;
    if (ready) vectors.push(ready);
    else if (opts.alsoVector && !vectors.length) return keywordSearch(index, queries);
  } catch (e) {
    console.error("[search] embedding the query failed, keyword search only:", (e as Error).message);
    return keywordSearch(index, queries);
  }
  // Short lists: the tail of a ranked list is noise, and fusing it in would dilute the top.
  const lists = [...queries.map((q) => index.search(q, PER_QUERY)), ...vectors.map((v) => index.semantic(v, embedder.model, PER_QUERY))];
  const fused = new Map<string, Hit>();
  for (const list of lists) {
    list.forEach((h, rank) => {
      const score = (fused.get(h.ref)?.score ?? 0) + 1 / (RRF + rank + 1);
      fused.set(h.ref, { ...h, score });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, PER_SEARCH);
}

export function cleanQueries(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 4);
}

const HANDLERS: Record<string, Handler> = {
  search_documents: async ({ index, embedder }, input) => {
    const queries = cleanQueries((input as { queries?: unknown })?.queries);
    return { hits: await runSearch(index, queries, { embedder }), label: queries[0] };
  },
  // Only the page after one the agent already holds, in the same document.
  read_pages: ({ index, seen }, input) => {
    const ref = String((input as { after_ref?: unknown })?.after_ref ?? "").trim();
    const from = seen.get(ref);
    if (!from) return { hits: [], note: "You can only continue from a passage you were given." };
    const next = index.get(`${from.docId}:${from.n + 1}`);
    return next ? { hits: [{ ...next, score: 0 }] } : { hits: [], note: "There is no following page." };
  },
};

export type AgentSkill = ToolDef & { access: "read"; run: Handler };

// Loads the declared skills. A declaration without code, or with any access other than
// "read", stops the server from answering rather than giving the agent an undefined power.
export function loadAgentSkills(dir: string = path.resolve("skills", "agent")): AgentSkill[] {
  return fs
    .readdirSync(/*turbopackIgnore: true*/ dir)
    .sort()
    .map((name) => {
      const decl = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, name, "skill.json"), "utf8")) as ToolDef & { access?: string };
      if (decl.name !== name) throw new Error(`agent skill ${name}: the folder name and "name" differ`);
      if (decl.access !== "read") throw new Error(`agent skill ${name}: only "read" access is allowed`);
      const run = HANDLERS[name];
      if (!run) throw new Error(`agent skill ${name}: declared but not implemented`);
      return { name: decl.name, description: decl.description, input_schema: decl.input_schema, access: "read" as const, run };
    });
}

let loaded: AgentSkill[] | undefined;
export function agentSkills(): AgentSkill[] {
  return (loaded ??= loadAgentSkills());
}
