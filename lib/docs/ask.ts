// Answers a technician's question from the documents of one knowledge base.
// The model can act only through the agent skills (lib/docs/agent-skills.ts), and it only
// drafts; the code decides what reaches the technician:
// every step must cite a passage that was really retrieved and quote text that is really in
// it, and an answer on a hazard topic always carries a warning the model cannot remove.
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { imageBlock, type AgentMessage, type ModelClient, type SkillContent } from "../llm";
import { HAZARD_TOPICS } from "../safety";
import type { DocMeta } from "../store/types";
import { agentSkills, cleanQueries, runSearch } from "./agent-skills";
import { imageSize, type Size } from "./image-size";
import type { Hit, SearchIndex } from "./search";

export const MAX_TURNS = 5;
export const MAX_STEPS = 6;
// A question may search this many times in total, whatever the model asks for.
const MAX_SEARCHES = 6;
const PASSAGE_CHARS = 6000;
// Pages of the first search that the model also gets as pictures, so it can point at a drawing.
const PAGES_AS_IMAGES = 2;
// Passages of the first search handed to the main model. Fewer passages, faster first step.
const FIRST_PASSAGES = 6;
const MAX_FIGURES = 2;
// Checks suggested from the model's own professional knowledge, shown apart from the manual's steps.
export const MAX_IDEAS = 4;

export type HazardTopic = "brakes" | "fuel" | "hot_coolant" | "running_engine" | "other";

export type SourceView = { docId: string; docName: string; origin: DocMeta["origin"]; unit: DocMeta["unit"]; n: number };
export type Box = { x: number; y: number; w: number; h: number };
// A drawing cut out of a manual page: `box` in thousandths of the page, `aspect` = page width / height.
export type DocFigure = { source: SourceView; caption: string; box: Box; aspect: number };
export type DocMark = { frame: number; step: number; label: string; box: { x: number; y: number; w: number; h: number } };

export type Likelihood = "high" | "medium" | "low";
// A place to check that is NOT from the documents: the model's general professional knowledge.
// `minutes` is how long the check takes. Shown apart from the verified steps; on a hazard topic,
// under the same warning as the steps.
export type DocIdea = { text: string; why: string; likelihood: Likelihood; minutes: number };

// What is stored in the conversation and shown. `quote` is the manual's own wording, shown
// when the technician opens a source.
export type DocResult =
  // `caution`: the answer touches a hazard topic and is shown under a warning.
  | { kind: "answer"; title: string; steps: { text: string; quote: string; source: SourceView }[]; marks: DocMark[]; figures?: DocFigure[]; caution?: HazardTopic; ideas?: DocIdea[] }
  // Nothing in the documents, only suggested checks from general knowledge.
  | { kind: "ideas"; ideas: DocIdea[]; caution?: HazardTopic }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "not_found" }
  | { kind: "hazard"; topic: HazardTopic; sources: SourceView[] }
  | { kind: "error" };

export type AskProgress = { stage: "looking" | "searching" | "reading" | "writing" | "checking"; detail?: string };

// The answer while it is still being written: only steps that already passed verification.
export type PartialAnswer = { title: string; steps: { text: string; quote: string; source: SourceView }[]; caution?: HazardTopic };

export type PageShot = { data: string; mediaType: "image/png"; width: number; height: number };

export type AskInput = {
  kbName: string;
  docs: DocMeta[];
  question?: string;
  images: Extract<SkillContent, { type: "image" }>[];
  media?: "photo" | "video";
  // Earlier turns, oldest first.
  history: { said?: string; result: DocResult }[];
  // Renders a page of a document as a picture. Absent in tests and for non-PDF documents.
  pageImage?: (hit: Hit) => Promise<PageShot | null>;
  // False when this knowledge base answers from its documents only. Default: suggestions allowed.
  ideas?: boolean;
};

type Draft = {
  kind: "answer" | "ask" | "not_found";
  title: string;
  steps: { text: string; ref: string; quote: string }[];
  checks?: DocIdea[];
  question: string;
  options: string[];
  marks: DocMark[];
  figures: { ref: string; caption: string; box: Box }[];
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
export function hazardTopic(question: string | undefined, draft: Pick<Draft, "hazard" | "steps"> & { checks?: { text: string; why?: string }[] }): HazardTopic | null {
  if (draft.hazard !== "none") return draft.hazard;
  const q = question ?? "";
  // The Hebrew topics are checked on the question and on everything the technician would read.
  const hebrewText = [q, ...draft.steps.map((s) => s.text), ...(draft.checks ?? []).flatMap((c) => [c.text, c.why ?? ""])].join("\n");
  const hebrew = HAZARD_TOPICS.find((t) => t.pattern.test(hebrewText));
  if (hebrew) return HEBREW_TOPIC[hebrew.topic] ?? "other";
  const text = [q, ...draft.steps.map((s) => s.quote)].join("\n");
  return HAZARD_EN.find((t) => t.pattern.test(text))?.topic ?? null;
}

const sourceOf = (h: Omit<Hit, "score">): SourceView => ({ docId: h.docId, docName: h.docName, origin: h.origin, unit: h.unit, n: h.n });

// The model gives boxes in the pixels of the picture it was shown. This turns one into
// thousandths of the picture's width and height, which is how boxes are stored and drawn.
export function toThousandths(box: Box, size: Size | null | undefined): Box | null {
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  const clamp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  const x = clamp((box.x / size.width) * 1000);
  const y = clamp((box.y / size.height) * 1000);
  return { x, y, w: Math.min(1000 - x, clamp((box.w / size.width) * 1000)), h: Math.min(1000 - y, clamp((box.h / size.height) * 1000)) };
}

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

const inRange = (v: number) => Number.isInteger(v) && v >= 0 && v <= 1000;
const validBox = ({ x, y, w, h }: Box) => [x, y, w, h].every(inRange) && w >= 60 && h >= 60 && x + w <= 1000 && y + h <= 1000;

// The order is decided here, not by the model: how likely the cause is, divided by how long the
// check takes. A one-minute check of an unlikely cause comes before a long check of a likely one.
const LIKELIHOOD: Record<Likelihood, number> = { high: 0.6, medium: 0.3, low: 0.1 };
export function rankIdeas(checks: unknown): DocIdea[] {
  if (!Array.isArray(checks)) return [];
  return checks
    .flatMap((c: Partial<DocIdea> | null) => {
      const text = typeof c?.text === "string" ? c.text.trim().slice(0, 300) : "";
      if (!text || !c || !(c.likelihood! in LIKELIHOOD)) return [];
      const minutes = Math.max(1, Math.min(240, Math.round(Number(c.minutes)) || 1));
      return [{ text, why: typeof c.why === "string" ? c.why.trim().slice(0, 300) : "", likelihood: c.likelihood as Likelihood, minutes }];
    })
    .map((idea, i) => ({ idea, i, score: LIKELIHOOD[idea.likelihood] / idea.minutes }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_IDEAS)
    .map((x) => x.idea);
}

type KeptStep = { text: string; quote: string; source: SourceView; from: number };

// A step is kept only when it cites a passage that was retrieved in this turn and quotes text
// that is really in it.
function keepSteps(steps: Draft["steps"], seen: Map<string, Hit>): KeptStep[] {
  const kept: KeptStep[] = [];
  steps.slice(0, MAX_STEPS).forEach((s, from) => {
    const hit = seen.get(String(s.ref ?? "").trim());
    if (hit && typeof s.text === "string" && s.text.trim() && typeof s.quote === "string" && quoteInPassage(s.quote, hit.text)) {
      kept.push({ text: s.text.trim().slice(0, 600), quote: s.quote.trim().slice(0, 400), source: sourceOf(hit), from });
    }
  });
  return kept;
}

// Turns the model's draft into what may be shown. `seen` holds every passage the skills
// returned in this turn; `shots` the pages the model was shown as pictures.
export function verifyDraft(
  draft: Draft,
  seen: Map<string, Hit>,
  question: string | undefined,
  // The pixel size of each picture the technician attached (null when it could not be read).
  frameSizes: (Size | null)[],
  shots: Map<string, PageShot> = new Map(),
  // False when the knowledge base answers from its documents only.
  allowIdeas = true,
): DocResult {
  if (draft.kind === "ask") {
    const question2 = draft.question.trim();
    const options = draft.options.map((o) => o.trim()).filter(Boolean).slice(0, 4);
    return question2 ? { kind: "ask", question: question2.slice(0, 300), options } : { kind: "not_found" };
  }

  const kept = keepSteps(draft.steps, seen);

  // A hazard topic with nothing to show at all: a stop, so nobody improvises.
  const topic = hazardTopic(question, draft);
  // Suggestions from general knowledge. On a hazard topic they are shown under the warning.
  const ideas = allowIdeas ? rankIdeas(draft.checks) : [];
  if (draft.kind === "not_found" || kept.length === 0) {
    if (ideas.length) return { kind: "ideas", ideas, ...(topic ? { caution: topic } : {}) };
    return topic ? { kind: "hazard", topic, sources: [] } : { kind: "not_found" };
  }

  // Marks point at steps by index; re-point them after dropped steps.
  const index = new Map(kept.map((k, i) => [k.from, i]));
  const marks = validDocMarks(
    draft.marks
      .filter((m) => index.has(m.step))
      .flatMap((m) => {
        const box = toThousandths(m.box, frameSizes[m.frame]);
        return box ? [{ ...m, box, step: index.get(m.step)! }] : [];
      }),
    frameSizes.length,
    kept.length,
  );
  // A drawing is shown only from a page the model really saw, and only from a page the answer cites.
  const cited = new Set(kept.map((k) => `${k.source.docId}:${k.source.n}`));
  const figures: DocFigure[] = (draft.figures ?? [])
    .flatMap((f) => {
      const shot = shots.get(f.ref);
      const box = shot && cited.has(f.ref) && seen.has(f.ref) ? toThousandths(f.box, shot) : null;
      return box && validBox(box) ? [{ source: sourceOf(seen.get(f.ref)!), caption: String(f.caption ?? "").trim().slice(0, 80), box, aspect: shot!.width / shot!.height }] : [];
    })
    .slice(0, MAX_FIGURES);
  return {
    kind: "answer",
    title: draft.title.trim().slice(0, 80),
    steps: kept.map(({ text, quote, source }) => ({ text, quote, source })),
    marks,
    ...(figures.length ? { figures } : {}),
    ...(topic ? { caution: topic } : {}),
    ...(ideas.length ? { ideas } : {}),
  };
}

// --- reading the answer while it is being written -------------------------------------------

const jsonString = (text: string, key: string): string | undefined => {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return undefined;
  }
};

// The step objects that are already complete in a partly written answer.
function completeSteps(text: string): Draft["steps"] {
  const start = text.search(/"steps"\s*:\s*\[/);
  if (start < 0) return [];
  const out: Draft["steps"] = [];
  let depth = 0;
  let inString = false;
  let objectStart = -1;
  for (let i = text.indexOf("[", start) + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") {
      if (depth++ === 0) objectStart = i;
    } else if (c === "}") {
      if (--depth === 0) {
        try {
          out.push(JSON.parse(text.slice(objectStart, i + 1)));
        } catch {
          return out;
        }
      }
    } else if (c === "]" && depth === 0) break;
  }
  return out;
}

// What can already be shown from a partly written answer: verified steps only, and the
// warning as soon as anything calls for it.
export function partialAnswer(text: string, seen: Map<string, Hit>, question: string | undefined): PartialAnswer | null {
  if (jsonString(text, "kind") !== "answer") return null;
  const title = jsonString(text, "title");
  if (title === undefined) return null;
  const steps = completeSteps(text);
  const kept = keepSteps(steps, seen);
  if (!kept.length) return null;
  const flagged = jsonString(text, "hazard");
  const hazard = flagged && flagged !== "none" ? (flagged as HazardTopic) : "none";
  const topic = hazardTopic(question, { hazard, steps });
  return { title: title.trim().slice(0, 80), steps: kept.map(({ text: t, quote, source }) => ({ text: t, quote, source })), ...(topic ? { caution: topic } : {}) };
}

// --- the first search ---------------------------------------------------------------------

const PLAN_SYSTEM = `A field technician asks a question in Hebrew about a machine. Their knowledge base holds the documents listed in the input.
Each document in the input states its language. Write 2 to 4 short keyword search queries in that language (for an English manual, English queries, whatever language the question is in) that would find the passages answering the question: the direct term, a synonym, and where a manual would put it (for example "tire pressure", "specifications tires").
If photos are attached, use what they show (an indicator, a part) to choose the terms.
If the question only makes sense with the conversation history, use the history to complete it.
Return an empty list when the message is not a question about the machine or its documents.`;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: { queries: { type: "array", items: { type: "string" } } },
};

// A small fast model writes the first queries, so the main model starts with the passages in
// hand and usually answers in one call. Any failure here just means no head start.
async function firstSearch(client: ModelClient, index: SearchIndex, context: string, input: AskInput): Promise<{ queries: string[]; hits: Hit[] } | null> {
  try {
    const reply = await client.complete({ system: PLAN_SYSTEM, content: [...input.images, { type: "text", text: context }], schema: PLAN_SCHEMA, fast: true });
    const raw = (JSON.parse(reply.text ?? "{}") as { queries?: unknown }).queries;
    const queries = cleanQueries(raw);
    if (!queries.length) return null;
    return { queries, hits: runSearch(index, queries) };
  } catch {
    return null;
  }
}

// --- the tool loop -------------------------------------------------------------------------

function describeResult(r: DocResult): string {
  if (r.kind === "answer") return `Answered "${r.title}": ${r.steps.map((s) => s.text).join(" / ")}${r.ideas?.length ? ` Also suggested checks (not from the documents): ${r.ideas.map((i) => i.text).join(" / ")}` : ""}`;
  if (r.kind === "ideas") return `Said it is not in the documents, and suggested checks from general knowledge: ${r.ideas.map((i) => i.text).join(" / ")}`;
  if (r.kind === "ask") return `Asked the technician: ${r.question} (options: ${r.options.join(", ")})`;
  if (r.kind === "hazard") return "Stopped: hazard topic with nothing in the documents to show.";
  if (r.kind === "not_found") return "Said it is not in the documents.";
  return "No answer (technical error).";
}

function contextOf(input: AskInput, index: SearchIndex, frameSizes: (Size | null)[]): string {
  const context = {
    knowledge_base: input.kbName,
    documents: input.docs.map((d) => ({ name: d.name, language: index.language(d.id), from: d.origin, pages: d.passages })),
    attached_pictures: frameSizes.map((s, frame) => ({ frame, pixels: s ? `${s.width} x ${s.height}` : "unknown" })),
    history: input.history.slice(-4).map((h) => ({ technician: h.said ?? "(sent media)", assistant: describeResult(h.result) })),
    attached: input.images.length ? `${input.images.length} ${input.media === "video" ? "video frames" : "photo(s)"}` : "nothing",
    technician: input.question ?? "(no text, only the attached media)",
    suggested_checks: input.ideas === false ? "off: this knowledge base answers from its documents only, return an empty `checks` list" : "allowed",
  };
  return JSON.stringify(context, null, 1);
}

function searchResultText(hits: Hit[]): string {
  if (!hits.length) return "No passages matched. Try different keywords.";
  return hits
    .map((h) => `<passage ref="${h.ref}" document="${h.docName.replace(/["<>]/g, "")}" ${h.unit}="${h.n}">\n${h.text.slice(0, PASSAGE_CHARS).replace(/<\/?passage/gi, "")}\n</passage>`)
    .join("\n\n");
}

export type AskRun = { result: DocResult; searches: string[][]; errors: string[] };

export async function askDocuments(
  client: ModelClient,
  index: SearchIndex,
  input: AskInput,
  progress: (p: AskProgress) => void = () => {},
  // Aborted when the technician's phone disconnects: no more model calls are made.
  signal?: AbortSignal,
  // Called as the answer is written, with the steps verified so far.
  onPartial: (p: PartialAnswer) => void = () => {},
): Promise<AskRun> {
  const { prompt, schema } = skill();
  const skills = agentSkills();
  const validate = new Ajv().compile<Draft>(schema);
  const seen = new Map<string, Hit>();
  const shots = new Map<string, PageShot>();
  const searches: string[][] = [];
  const errors: string[] = [];
  const frameSizes = input.images.map((i) => imageSize(i.data, i.mediaType));
  const context = contextOf(input, index, frameSizes);
  progress({ stage: input.images.length ? "looking" : "searching" });

  const content: AgentMessage["content"] = [...input.images.map(imageBlock)];
  const head = await firstSearch(client, index, context, input);
  let found = "";
  if (head) {
    searches.push(head.queries);
    head.hits = head.hits.slice(0, FIRST_PASSAGES);
    for (const h of head.hits) seen.set(h.ref, h);
    progress({ stage: "searching", detail: head.queries[0] });
    if (head.hits.length) progress({ stage: "reading", detail: `${head.hits[0].docName} · ${head.hits.slice(0, 3).map((h) => h.n).join(", ")}` });
    found = `\n\nA first search was already run for you with the queries ${JSON.stringify(head.queries)}. Its results:\n\n${searchResultText(head.hits)}\n\nAnswer from these passages when they are enough. Search again only if they lack what the answer needs.`;
    // The best pages also go in as pictures, so the answer can show the manual's own drawing.
    if (input.pageImage) {
      const pages = head.hits.filter((h) => h.unit === "page").slice(0, PAGES_AS_IMAGES);
      const rendered = await Promise.all(pages.map((h) => input.pageImage!(h).catch(() => null)));
      pages.forEach((h, i) => {
        const shot = rendered[i];
        if (!shot) return;
        shots.set(h.ref, shot);
        content.push({ type: "text", text: `Picture of the page with ref ${h.ref} (${shot.width} x ${shot.height} pixels):` }, imageBlock({ type: "image", mediaType: shot.mediaType, data: shot.data }));
      });
    }
    progress({ stage: "writing" });
  }
  content.push({ type: "text", text: context + found });
  const messages: AgentMessage[] = [{ role: "user", content }];

  let shown = 0;
  const onText = (snapshot: string) => {
    const partial = partialAnswer(snapshot, seen, input.question);
    if (partial && partial.steps.length > shown) {
      shown = partial.steps.length;
      onPartial(partial);
    }
  };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) {
        errors.push("client disconnected");
        break;
      }
      const reply = await client.turn({ system: prompt, messages, tools: skills.map(({ name, description, input_schema }) => ({ name, description, input_schema })), schema }, onText);

      if (reply.toolCalls.length) {
        messages.push(reply.assistant);
        const results = reply.toolCalls.map((call) => {
          // The agent can only use a declared skill. Anything else is refused, and nothing runs.
          const used = skills.find((s) => s.name === call.name);
          if (!used) return { type: "tool_result" as const, tool_use_id: call.id, is_error: true, content: `There is no skill named "${call.name}". Your skills: ${skills.map((s) => s.name).join(", ")}.` };
          if (searches.length >= MAX_SEARCHES) return { type: "tool_result" as const, tool_use_id: call.id, content: "Skill limit reached. Answer from the passages you already have." };
          const outcome = used.run({ index, seen }, call.input);
          searches.push(cleanQueries((call.input as { queries?: unknown })?.queries));
          progress({ stage: "searching", detail: outcome.label });
          for (const h of outcome.hits) seen.set(h.ref, h);
          if (outcome.hits.length) progress({ stage: "reading", detail: `${outcome.hits[0].docName} · ${outcome.hits.slice(0, 3).map((h) => h.n).join(", ")}` });
          return { type: "tool_result" as const, tool_use_id: call.id, content: outcome.note ?? searchResultText(outcome.hits) };
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
      return { result: verifyDraft(draft, seen, input.question, frameSizes, shots, input.ideas !== false), searches, errors };
    }
    if (!errors.length) errors.push("too many turns");
  } catch (e) {
    const status = (e as { status?: number }).status;
    errors.push(`${status ? `HTTP ${status}: ` : ""}${(e as Error).message}`);
  }
  return { result: { kind: "error" }, searches, errors };
}
