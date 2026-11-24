// The technician's question in English, for a search over manuals that are mostly in English.
// Search by meaning crosses languages only roughly, and search by words not at all, so a
// question in Hebrew alone can miss the page. The live model normally hands the English over
// with the question; this is what stands in when it did not. It only translates: what it
// writes is searched, never shown or spoken.
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm";

// `terms`: the parts and symptoms the technician named, as a manual would print them: a second way in by words.
export type InEnglish = { english: string; terms?: string };
export type Translator = (question: string) => Promise<InEnglish | null>;

let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function job() {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "jobs", "english");
  return (files ??= { prompt: fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), schema: JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")) });
}

// A question written in Latin letters is searched as it is.
export const needsEnglish = (question: string) => /[^\u0000-ɏ]/.test(question);

// Null when the model could not be asked or returned nothing: the search goes on without it.
export function modelTranslator(client: ModelClient): Translator {
  return async (question) => {
    const { prompt, schema } = job();
    try {
      const response = await client.complete({ system: prompt, schema, fast: true, content: [{ type: "text", text: question }] });
      const reply = JSON.parse(response.text ?? "") as { english?: unknown; terms?: unknown };
      const english = typeof reply.english === "string" ? reply.english.trim().slice(0, 300) : "";
      const terms = typeof reply.terms === "string" ? reply.terms.trim().slice(0, 200) : "";
      return english ? { english, ...(terms ? { terms } : {}) } : null;
    } catch {
      return null;
    }
  };
}
