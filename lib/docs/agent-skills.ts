// The only things the agent can do. The model has no abilities of its own: it can ask for a
// skill by name, and the code here decides whether that skill exists and runs it.
// A skill is declared in skills/agent/<name>/skill.json (what the model is told, and its
// access level) and implemented below. Every skill is read-only: nothing here can write to a
// knowledge base, reach the network, or act outside the knowledge base the technician is in.
import fs from "node:fs";
import path from "node:path";
import type { ToolDef } from "../llm";
import type { Hit, SearchIndex } from "./search";

const PER_QUERY = 4;
const PER_SEARCH = 8;

export type SkillContext = { index: SearchIndex; seen: Map<string, Hit> };
export type SkillOutcome = { hits: Hit[]; note?: string; label?: string };
type Handler = (ctx: SkillContext, input: unknown) => SkillOutcome;

export function runSearch(index: SearchIndex, queries: string[]): Hit[] {
  const merged = new Map<string, Hit>();
  for (const q of queries) for (const h of index.search(q, PER_QUERY)) if (!merged.has(h.ref) || merged.get(h.ref)!.score < h.score) merged.set(h.ref, h);
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, PER_SEARCH);
}

export function cleanQueries(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 4);
}

const HANDLERS: Record<string, Handler> = {
  search_documents: ({ index }, input) => {
    const queries = cleanQueries((input as { queries?: unknown })?.queries);
    return { hits: runSearch(index, queries), label: queries[0] };
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
