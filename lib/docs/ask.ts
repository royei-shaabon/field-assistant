// Answers a technician's question from the documents of one knowledge base.
// The model searches (tool loop) and drafts; the code decides what reaches the technician:
// every step must cite a passage that was really retrieved and quote text that is really in
// it, and an answer on a hazard topic always carries a warning the model cannot remove.
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { imageBlock, type AgentMessage, type ModelClient, type SkillContent, type ToolDef } from "../llm";
import { HAZARD_TOPICS } from "../safety";
import type { DocMeta } from "../store/types";
import type { Hit, SearchIndex } from "./search";

export const MAX_TURNS = 5;
export const MAX_STEPS = 6;
const PER_QUERY = 4;
const PER_SEARCH = 8;
const PASSAGE_CHARS = 6000;

export type HazardTopic = "brakes" | "fuel" | "hot_coolant" | "running_engine" | "other";

export type SourceView = { docId: string; docName: string; origin: DocMeta["origin"]; unit: DocMeta["unit"]; n: number };
export type DocMark = { frame: number; step: number; label: string; box: { x: number; y: number; w: number; h: number } };

// What is stored in the conversation and shown. `quote` is the manual's own wording, shown
// when the technician opens a source.
export type DocResult =
  // `caution`: the answer touches a hazard topic and is shown under a warning.
  | { kind: "answer"; title: string; steps: { text: string; quote: string; source: SourceView }[]; marks: DocMark[]; caution?: HazardTopic }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "not_found" }
  | { kind: "hazard"; topic: HazardTopic; sources: SourceView[] }
  | { kind: "error" };

export type AskProgress = { stage: "looking" | "searching" | "reading" | "writing" | "checking"; detail?: string };

export type AskInput = {
  kbName: string;
  docs: DocMeta[];
  question?: string;
  images: Extract<SkillContent, { type: "image" }>[];
  media?: "photo" | "video";
  // Earlier turns, oldest first.
  history: { said?: string; result: DocResult }[];
};

type Draft = {
  kind: "answer" | "ask" | "not_found";
  title: string;
  steps: { text: string; ref: string; quote: string }[];
  question: string;
  options: string[];
  marks: DocMark[];
  hazard: "none" | HazardTopic;
};

const SKILL_DIR = path.resolve("skills", "ask");
let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function skill() {
  files ??= {
    prompt: fs.readFileSync(path.join(/*turbopackIgnore: true*/ SKILL_DIR, "prompt.md"), "utf8"),
    schema: JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ SKILL_DIR, "schema.json"), "utf8")),
  };
  return files;
}

const SEARCH_TOOL: ToolDef = {
  name: "search_documents",
  description:
    "Keyword search over the passages of this knowledge base. Returns the best matching passages with their reference, document name and page. Queries must be in the language of the documents.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["queries"],
    properties: { queries: { type: "array", items: { type: "string" }, description: "1 to 4 short keyword queries." } },
  },
};

// --- grounding -----------------------------------------------------------------------------

const norm = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

// True when the quote is really in the passage: as a contiguous run of words, or, to forgive
// PDF line-break noise, with at least 90% of its words found in order.
export function quoteInPassage(quote: string, passage: string): boolean {
  const q = norm(quote);
  const words = q.split(" ").filter(Boolean);
  if (words.length < 3) return false;
  const p = norm(passage);
  if (p.includes(q)) return true;
  const passageWords = p.split(" ");
  let at = 0;
  let found = 0;
  for (const w of words) {
    const i = passageWords.indexOf(w, at);
    if (i >= 0 && i - at < 12) {
      found++;
      at = i + 1;
    }
  }
  return words.length >= 5 && found / words.length >= 0.9;
}

// English wording of the fixed hazard topics, matched against the question and the cited quotes.
// Narrow on purpose: "fuel gauge" or "coolant temperature indicator" is not work on the system.
const HAZARD_EN: { topic: HazardTopic; pattern: RegExp }[] = [
  { topic: "brakes", pattern: /\bbrakes?\b|\babs\b/i },
  { topic: "fuel", pattern: /\bfuel (system|line|hose|pump|filter|injector|tank|leak)|\b(gasoline|petrol)\b/i },
  { topic: "hot_coolant", pattern: /\bradiator cap\b|\bcoolant\b[^.]*\bhot\b|\bhot\b[^.]*\bcoolant\b/i },
  { topic: "running_engine", pattern: /\bengine (is )?running\b|\bwith the engine (running|on)\b/i },
];
const HEBREW_TOPIC: Record<string, HazardTopic> = { brakes: "brakes", fuel: "fuel", coolant: "hot_coolant", "running-engine": "running_engine" };

// The hazard decision is made here, not by the model: the model's flag can only add a warning.
export function hazardTopic(question: string | undefined, draft: Pick<Draft, "hazard" | "steps">): HazardTopic | null {
  if (draft.hazard !== "none") return draft.hazard;
  const q = question ?? "";
  const hebrew = HAZARD_TOPICS.find((t) => t.pattern.test(q));
  if (hebrew) return HEBREW_TOPIC[hebrew.topic] ?? "other";
  const text = [q, ...draft.steps.map((s) => s.quote)].join("\n");
  return HAZARD_EN.find((t) => t.pattern.test(text))?.topic ?? null;
}

const sourceOf = (h: Omit<Hit, "score">): SourceView => ({ docId: h.docId, docName: h.docName, origin: h.origin, unit: h.unit, n: h.n });

export function validDocMarks(marks: DocMark[], frames: number, steps: number): DocMark[] {
  const inRange = (v: number) => Number.isInteger(v) && v >= 0 && v <= 1000;
  return marks
    .filter(({ frame, step, label, box: { x, y, w, h } }) => {
      return (
        Number.isInteger(frame) && frame >= 0 && frame < frames && Number.isInteger(step) && step >= 0 && step < steps &&
        label.trim().length > 0 && [x, y, w, h].every(inRange) && w > 0 && h > 0 && x + w <= 1000 && y + h <= 1000
      );
    })
    .slice(0, 6)
    .map((m) => ({ ...m, label: m.label.trim().slice(0, 40) }));
}

// Turns the model's draft into what may be shown. `seen` holds every passage the search
// returned in this turn; a step that cites anything else, or misquotes, is dropped.
export function verifyDraft(draft: Draft, seen: Map<string, Hit>, question: string | undefined, frames: number): DocResult {
  if (draft.kind === "ask") {
    const question2 = draft.question.trim();
    const options = draft.options.map((o) => o.trim()).filter(Boolean).slice(0, 4);
    return question2 ? { kind: "ask", question: question2.slice(0, 300), options } : { kind: "not_found" };
  }

  const kept: { text: string; quote: string; source: SourceView; from: number }[] = [];
  draft.steps.slice(0, MAX_STEPS).forEach((s, from) => {
    const hit = seen.get(s.ref.trim());
    if (hit && s.text.trim() && quoteInPassage(s.quote, hit.text)) {
      kept.push({ text: s.text.trim().slice(0, 600), quote: s.quote.trim().slice(0, 400), source: sourceOf(hit), from });
    }
  });

  // A hazard topic with nothing verified to show: a stop, so nobody improvises.
  const topic = hazardTopic(question, draft);
  if (topic && kept.length === 0) return { kind: "hazard", topic, sources: [] };
  if (draft.kind === "not_found" || kept.length === 0) return { kind: "not_found" };

  // Marks point at steps by index; re-point them after dropped steps.
  const index = new Map(kept.map((k, i) => [k.from, i]));
  const marks = validDocMarks(
    draft.marks.filter((m) => index.has(m.step)).map((m) => ({ ...m, step: index.get(m.step)! })),
    frames,
    kept.length,
  );
  return {
    kind: "answer",
    title: draft.title.trim().slice(0, 80),
    steps: kept.map(({ text, quote, source }) => ({ text, quote, source })),
    marks,
    ...(topic ? { caution: topic } : {}),
  };
}

// --- the tool loop -------------------------------------------------------------------------

function describeResult(r: DocResult): string {
  if (r.kind === "answer") return `Answered "${r.title}": ${r.steps.map((s) => s.text).join(" / ")}`;
  if (r.kind === "ask") return `Asked the technician: ${r.question} (options: ${r.options.join(", ")})`;
  if (r.kind === "hazard") return "Stopped: hazard topic with nothing in the documents to show.";
  if (r.kind === "not_found") return "Said it is not in the documents.";
  return "No answer (technical error).";
}

function firstMessage(input: AskInput): AgentMessage {
  const context = {
    knowledge_base: input.kbName,
    documents: input.docs.map((d) => ({ name: d.name, from: d.origin, pages: d.passages })),
    history: input.history.slice(-4).map((h) => ({ technician: h.said ?? "(sent media)", assistant: describeResult(h.result) })),
    attached: input.images.length ? `${input.images.length} ${input.media === "video" ? "video frames" : "photo(s)"}` : "nothing",
    technician: input.question ?? "(no text, only the attached media)",
  };
  return { role: "user", content: [...input.images.map(imageBlock), { type: "text", text: JSON.stringify(context, null, 1) }] };
}

function searchResultText(hits: Hit[]): string {
  if (!hits.length) return "No passages matched. Try different keywords.";
  return hits
    .map((h) => `[ref ${h.ref}] ${h.docName}, ${h.unit} ${h.n}\n${h.text.slice(0, PASSAGE_CHARS)}`)
    .join("\n\n-----\n\n");
}

export type AskRun = { result: DocResult; searches: string[][]; errors: string[] };

export async function askDocuments(
  client: ModelClient,
  index: SearchIndex,
  input: AskInput,
  progress: (p: AskProgress) => void = () => {},
): Promise<AskRun> {
  const { prompt, schema } = skill();
  const validate = new Ajv().compile<Draft>(schema);
  const seen = new Map<string, Hit>();
  const searches: string[][] = [];
  const errors: string[] = [];
  const messages: AgentMessage[] = [firstMessage(input)];
  progress({ stage: input.images.length ? "looking" : "searching" });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await client.turn({ system: prompt, messages, tools: [SEARCH_TOOL], schema });

      if (reply.toolCalls.length) {
        messages.push(reply.assistant);
        const results = reply.toolCalls.map((call) => {
          const raw = (call.input as { queries?: unknown })?.queries;
          const queries = (Array.isArray(raw) ? raw : []).filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 4);
          searches.push(queries);
          progress({ stage: "searching", detail: queries[0] });
          const merged = new Map<string, Hit>();
          for (const q of queries) for (const h of index.search(q, PER_QUERY)) if (!merged.has(h.ref) || merged.get(h.ref)!.score < h.score) merged.set(h.ref, h);
          const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, PER_SEARCH);
          for (const h of hits) seen.set(h.ref, h);
          if (hits.length) progress({ stage: "reading", detail: `${hits[0].docName} · ${hits.slice(0, 3).map((h) => h.n).join(", ")}` });
          return { type: "tool_result" as const, tool_use_id: call.id, content: searchResultText(hits) };
        });
        messages.push({ role: "user", content: results });
        continue;
      }

      if (reply.text === null) {
        errors.push(`no output (stop_reason: ${reply.stopReason})`);
        break;
      }
      progress({ stage: "checking" });
      let draft: unknown;
      try {
        draft = JSON.parse(reply.text);
      } catch {
        errors.push("output is not JSON");
        break;
      }
      if (!validate(draft)) {
        errors.push(`schema: ${new Ajv().errorsText(validate.errors)}`);
        break;
      }
      return { result: verifyDraft(draft, seen, input.question, input.images.length), searches, errors };
    }
    if (!errors.length) errors.push("too many turns");
  } catch (e) {
    errors.push((e as Error).message);
  }
  return { result: { kind: "error" }, searches, errors };
}
