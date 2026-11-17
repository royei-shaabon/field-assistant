// Second look at what the search found. Search is quick and rough: it brings sections that
// share words or meaning with the question. A small, fast model then reads those sections
// with the question and puts the ones that really answer it first, and drops the rest.
// It only orders and drops: it writes nothing the technician hears or reads.
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm";

export type Candidate = { id: number; text: string };
export type Reranker = (question: string, candidates: Candidate[]) => Promise<number[] | null>;

let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function skill() {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "skills", "rerank");
  return (files ??= { prompt: fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), schema: JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")) });
}

// What the model returned, checked: only numbers that were offered, each once, in its order.
export function checkedOrder(raw: unknown, candidates: Candidate[]): number[] | null {
  const order = (raw as { order?: unknown } | null)?.order;
  if (!Array.isArray(order)) return null;
  const known = new Set(candidates.map((c) => c.id));
  return [...new Set(order.filter((n): n is number => Number.isInteger(n) && known.has(n)))];
}

// Null when the model could not be asked or answered nonsense: the caller keeps the search's order.
export function modelReranker(client: ModelClient): Reranker {
  return async (question, candidates) => {
    if (candidates.length < 2) return null;
    const { prompt, schema } = skill();
    const listed = candidates.map((c) => `<section number="${c.id}">\n${c.text}\n</section>`).join("\n");
    try {
      const response = await client.complete({ system: prompt, schema, fast: true, content: [{ type: "text", text: `Question: ${question}\n\n${listed}` }] });
      return checkedOrder(JSON.parse(response.text ?? ""), candidates);
    } catch {
      return null;
    }
  };
}
