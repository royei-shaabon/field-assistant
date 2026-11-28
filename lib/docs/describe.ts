// A draft of a document's description: what it is and what it is the right source for, and the
// model years it covers. The model only proposes; the implementer reads it, corrects it and
// saves it, and only what was saved reaches the assistant (as a fact about the document, in
// the list of documents, never as an instruction).
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm";
import type { Passage } from "../store/types";

export type AboutDraft = { about: string; years: string };

export const MAX_ABOUT = 400;
export const MAX_YEARS = 40;

// One paragraph, no markup that could pass for structure in a prompt.
export const cleanAbout = (text: unknown): string => (typeof text === "string" ? text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_ABOUT) : "");
// Model years: digits and what joins them ("2017-2018", "2019, 2021"). Anything else is dropped.
export const cleanYears = (text: unknown): string => {
  const clean = typeof text === "string" ? text.replace(/[–—]/g, "-").replace(/[^0-9,\- ]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_YEARS) : "";
  return /\b(19|20)\d{2}\b/.test(clean) ? clean : "";
};

let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function job() {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "jobs", "describe");
  return (files ??= { prompt: fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), schema: JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")) });
}

// What the model reads: the opening pages, and the first lines of pages spread through the rest.
export function sampleOf(passages: Passage[]): string {
  const opening = passages.slice(0, 4).map((p) => `[${p.n}] ${p.text.slice(0, 900)}`);
  const rest = passages.slice(4);
  const step = Math.max(1, Math.floor(rest.length / 24));
  const spread = rest.filter((_, i) => i % step === 0).slice(0, 24).map((p) => `[${p.n}] ${p.text.replace(/\s+/g, " ").slice(0, 160)}`);
  return [...opening, ...spread].join("\n\n").replace(/<\/?document>/gi, "");
}

// Null when the model could not be asked or wrote nothing usable: the implementer writes it by hand.
export async function draftAbout(client: ModelClient, doc: { name: string; machine: string }, passages: Passage[]): Promise<AboutDraft | null> {
  const { prompt, schema } = job();
  try {
    const text = `Machine: ${doc.machine}\nDocument name: ${doc.name}\nPages or parts: ${passages.length}\n\n<document>\n${sampleOf(passages)}\n</document>`;
    const response = await client.complete({ system: prompt, schema, content: [{ type: "text", text }] });
    const reply = JSON.parse(response.text ?? "") as { about?: unknown; years?: unknown };
    const about = cleanAbout(reply.about);
    return about ? { about, years: cleanYears(reply.years) } : null;
  } catch {
    return null;
  }
}
