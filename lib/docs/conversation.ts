// Conversation with a document knowledge base. Same contract as lib/conversation.ts: the client
// keeps only the event log, and the server rebuilds the screen from it on every request.
import Ajv from "ajv";
import { MAX_EVENTS, MAX_IMAGES, MAX_IMAGE_BASE64, MAX_TEXT, BadRequest, type ClientImage } from "../conversation";
import type { ModelClient } from "../llm";
import type { ChatItem, Screen } from "../screen";
import type { DocMeta, KbMeta } from "../store/types";
import { askDocuments, hazardTopic, rankIdeas, validDocMarks, type Audience, type AskInput, type AskProgress, type AskTiming, type FirstSearchMode, type DocResult, type PartialAnswer } from "./ask";
import type { Embedder } from "./embed";
import type { SearchIndex } from "./search";
import { log } from "../server/log";

// `again`: the pictures of this turn are the ones sent earlier in the conversation, attached again
// by the phone so a later question can be answered, and marked, on them.
// `remembered`: the technician told what solved a fault, and their words were kept for the team
// as a note that waits for the implementer's approval.
export type DocTurn = { type: "DOC_TURN"; said?: string; media?: "photo" | "video"; frames?: number; again?: true; remembered?: true; result: DocResult };
// What was said in a voice or video call, as the phone transcribed it: the technician's words
// and the assistant's. It is a record, not a checked answer; the chat shows it as the call's
// transcript, and it is part of what the next question (written or spoken) knows about.
export type CallLine = { by: "tech" | "bot"; text: string };
export type CallLog = { type: "CALL_LOG"; call: "voice" | "video"; lines: CallLine[] };
export type DocEvent = DocTurn | CallLog;
export const MAX_CALL_LINES = 60;
export const MAX_CALL_LINE = 400;

export type DocInput = { kind: "view" } | { kind: "ask"; text?: string; images?: ClientImage[]; media?: "photo" | "video"; again?: boolean } | { kind: "call_log"; call: "voice" | "video"; lines: CallLine[] };

export type DocRequest = { events: DocEvent[]; input: DocInput };
export type DocResponse = { events: DocEvent[]; screen: Screen };

const text = (max = MAX_TEXT) => ({ type: "string", maxLength: max });
const int = { type: "integer", minimum: 0, maximum: 1000 };
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required, properties });
const source = obj(["docId", "docName", "origin", "unit", "n"], {
  docId: text(80),
  docName: text(200),
  origin: { enum: ["manufacturer", "customer", "team"] },
  unit: { enum: ["page", "part"] },
  n: { type: "integer", minimum: 1 },
  years: text(40),
  read: { const: true },
});
const kind = (k: string) => ({ const: k });
const ideas = {
  type: "array",
  maxItems: 4,
  items: obj(["text", "why", "likelihood", "minutes"], { text: text(300), why: text(300), likelihood: { enum: ["high", "medium", "low"] }, minutes: { type: "integer", minimum: 1, maximum: 240 } }),
};

const callLines = { type: "array", minItems: 1, maxItems: MAX_CALL_LINES, items: obj(["by", "text"], { by: { enum: ["tech", "bot"] }, text: text(MAX_CALL_LINE) }) };
const callLog = obj(["type", "call", "lines"], { type: kind("CALL_LOG"), call: { enum: ["voice", "video"] }, lines: callLines });
const docTurn =
    obj(["type", "result"], {
      type: kind("DOC_TURN"),
      said: text(),
      media: { enum: ["photo", "video"] },
      frames: { type: "integer", minimum: 0, maximum: MAX_IMAGES },
      again: { const: true },
      remembered: { const: true },
      result: {
        oneOf: [
          obj(["kind", "title", "steps", "marks"], {
            kind: kind("answer"),
            caution: { enum: ["brakes", "fuel", "hot_coolant", "running_engine", "other", "maker"] },
            title: text(80),
            ideas,
            steps: { type: "array", maxItems: 6, items: obj(["text", "quote", "source"], { text: text(600), quote: text(400), source }) },
            figures: {
              type: "array",
              maxItems: 2,
              items: obj(["source", "caption", "box", "aspect"], {
                source,
                caption: text(80),
                box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }),
                aspect: { type: "number", minimum: 0.2, maximum: 5 },
                parts: { type: "array", maxItems: 6, items: obj(["name", "box"], { name: text(40), printed: text(60), asked: { const: true }, box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }) }) },
              }),
            },
            marks: {
              type: "array",
              maxItems: 6,
              items: obj(["frame", "step", "label", "box"], { frame: int, step: int, label: text(40), box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }) }),
            },
          }),
          obj(["kind", "question", "options"], {
            kind: kind("ask"),
            question: text(300),
            options: { type: "array", maxItems: 4, items: text(120) },
            marks: { type: "array", maxItems: 6, items: obj(["frame", "step", "label", "box"], { frame: int, step: int, label: text(40), box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }) }) },
          }),
          obj(["kind", "ideas"], { kind: kind("ideas"), caution: { enum: ["brakes", "fuel", "hot_coolant", "running_engine", "other"] }, ideas: { ...ideas, minItems: 1 } }),
          obj(["kind"], { kind: kind("not_found") }),
          obj(["kind", "topic", "sources"], {
            kind: kind("hazard"),
            topic: { enum: ["brakes", "fuel", "hot_coolant", "running_engine", "other"] },
            sources: { type: "array", maxItems: 6, items: source },
          }),
          obj(["kind"], { kind: kind("error") }),
        ],
      },
    });
const inputAsk =
      obj(["kind"], {
        kind: kind("ask"),
        text: text(),
        again: { type: "boolean" },
        media: { enum: ["photo", "video"] },
        images: {
          type: "array",
          minItems: 1,
          maxItems: MAX_IMAGES,
          items: obj(["mediaType", "data"], { mediaType: { enum: ["image/jpeg", "image/png", "image/webp"] }, data: { type: "string", maxLength: MAX_IMAGE_BASE64 } }),
        },
      });

const requestSchema = obj(["events", "input"], {
  events: { type: "array", maxItems: MAX_EVENTS, items: { oneOf: [callLog, docTurn] } },
  input: {
    oneOf: [obj(["kind"], { kind: kind("view") }), obj(["kind", "call", "lines"], { kind: kind("call_log"), call: { enum: ["voice", "video"] }, lines: callLines }), inputAsk],
  },
});

const validateRequest = new Ajv().compile<DocRequest>(requestSchema);

// The event log comes back from the client, so the hazard rule is applied again on every
// replay: anything on a hazard topic gets its warning back, whatever the log says, and
// suggested checks are dropped when the knowledge base turned them off.
function guarded(event: DocTurn, allowIdeas: boolean, audience: Audience): DocResult {
  const r = event.result;
  if (r.kind === "ideas") {
    const topic = r.caution ?? hazardTopic(event.said, { hazard: "none", steps: [], checks: r.ideas }) ?? undefined;
    // For a qualified audience suggested checks carry no topic warning; with nothing to show, the stop stays.
    const caution = topic === "maker" ? undefined : topic;
    const kept = allowIdeas ? rankIdeas(r.ideas) : [];
    if (kept.length) return { kind: "ideas", ideas: kept, ...(caution && audience === "general" ? { caution } : {}) };
    return caution ? { kind: "hazard", topic: caution, sources: [] } : { kind: "not_found" };
  }
  if (r.kind !== "answer") return r;
  const topic = hazardTopic(event.said, { hazard: "none", steps: r.steps.map((s) => ({ text: s.text, ref: "", quote: s.quote })), checks: r.ideas });
  // General audience: the topic warning is put back even if the log from the phone left it out.
  // Qualified audience: only the manufacturer's own notice, as the answer recorded it.
  const caution = audience === "general" ? (r.caution && r.caution !== "maker" ? r.caution : (topic ?? (r.caution === "maker" ? "maker" : undefined))) : r.caution === "maker" ? ("maker" as const) : undefined;
  // The warning is decided here, never copied from the log as it came.
  const { ideas: logged, caution: _logged, ...rest } = r;
  void _logged;
  const kept = allowIdeas ? rankIdeas(logged) : [];
  return { ...rest, marks: validDocMarks(r.marks, event.frames ?? 0, r.steps.length), ...(caution ? { caution } : {}), ...(kept.length ? { ideas: kept } : {}) };
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
export const cleanLines = (lines: CallLine[]): CallLine[] =>
  lines
    .map((l) => ({ by: l.by, text: oneLine(l.text, MAX_CALL_LINE) }))
    .filter((l) => l.text)
    .slice(-MAX_CALL_LINES);

// The conversation as plain text, newest last: what the technician wrote or said, and what the
// assistant answered. This is what a call is told about the chat before it, and what a written
// question is told about a call before it, so the three ways of talking are one conversation.
// Bounded: the newest part is kept.
export function conversationSoFar(events: DocEvent[], max = 2500): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "CALL_LOG") {
      for (const l of e.lines) lines.push(`${l.by === "tech" ? "Technician" : "Assistant"} (in a ${e.call} call): ${l.text}`);
      continue;
    }
    lines.push(`Technician: ${e.said ? oneLine(e.said, 300) : ""}${e.media && !e.again ? ` [sent ${e.frames ?? 1} ${e.media === "video" ? "video frame(s)" : "photo(s)"}]` : ""}`);
    const r = e.result;
    if (r.kind === "answer") lines.push(`Assistant: ${r.title}. ${r.steps.map((s, i) => `${i + 1}) ${oneLine(s.text, 160)}`).join(" ")}`);
    else if (r.kind === "ask") lines.push(`Assistant asked: ${oneLine(r.question, 200)}`);
    else if (r.kind === "ideas") lines.push(`Assistant: the documents do not cover it; suggested checks: ${r.ideas.map((i) => oneLine(i.text, 100)).join("; ")}`);
    else if (r.kind === "not_found") lines.push("Assistant: the documents do not cover it.");
    else if (r.kind === "hazard") lines.push("Assistant: stopped, a hazard topic with nothing in the documents to show.");
  }
  let out = "";
  for (let i = lines.length - 1; i >= 0 && out.length + lines[i].length + 1 <= max; i--) out = `${lines[i]}\n${out}`;
  return out.trim();
}

export function docScreen(events: DocEvent[], hasDocuments: boolean, allowIdeas = true, audience: Audience = "general"): Screen {
  const items: ChatItem[] = [];
  let title: string | undefined;
  events.forEach((event, eventIndex) => {
    if (event.type === "CALL_LOG") {
      items.push({ by: "bot", kind: "call_log", call: event.call, lines: event.lines });
      return;
    }
    if (event.media && !event.again) items.push({ by: "tech", kind: "media", media: event.media, frames: event.frames ?? 1, eventIndex, said: event.said });
    else if (event.said) items.push({ by: "tech", kind: "text", said: event.said });
    const r = guarded(event, allowIdeas, audience);
    if (r.kind === "answer") {
      title ??= r.title;
      items.push({ by: "bot", kind: "doc_answer", eventIndex, title: r.title, steps: r.steps, marks: r.marks, ...(r.figures?.length ? { figures: r.figures } : {}), ...(r.caution ? { caution: r.caution } : {}), ...(r.ideas?.length ? { ideas: r.ideas } : {}) });
    } else if (r.kind === "ideas") items.push({ by: "bot", kind: "doc_ideas", ideas: r.ideas, ...(r.caution ? { caution: r.caution } : {}) });
    else if (r.kind === "ask") {
      const seenParts = validDocMarks(r.marks ?? [], event.frames ?? 0, 1);
      items.push({ by: "bot", kind: "doc_ask", question: r.question, options: r.options, ...(seenParts.length ? { marks: seenParts, eventIndex } : {}) });
    }
    else if (r.kind === "hazard") items.push({ by: "bot", kind: "doc_hazard", topic: r.topic, sources: r.sources });
    // A message that only told what worked is not a question that went unanswered.
    else if (r.kind === "not_found") {
      if (!event.remembered) items.push({ by: "bot", kind: "doc_not_found" });
    }
    else items.push({ by: "bot", kind: "doc_error" });
    if (event.remembered) items.push({ by: "bot", kind: "doc_saved" });
  });
  if (!hasDocuments) items.push({ by: "bot", kind: "doc_empty" });
  title ??= events.find((e): e is DocTurn => e.type === "DOC_TURN" && Boolean(e.said))?.said?.slice(0, 40);
  return { items, mode: "identify", candidates: [], trees: [], title, danger: false };
}

export async function handleDocConversation(
  kb: { meta: KbMeta; docs: DocMeta[]; index: SearchIndex },
  client: ModelClient,
  body: unknown,
  progress: (p: AskProgress) => void = () => {},
  signal?: AbortSignal,
  // Live view of the answer while it is written, and the renderer of manual pages.
  live: { onPartial?: (p: PartialAnswer) => void; pageImage?: AskInput["pageImage"]; embedder?: Embedder | null; firstSearch?: FirstSearchMode; onTiming?: (t: AskTiming) => void; audience?: Audience; remember?: (text: string) => Promise<boolean>; look?: (image: { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }, label: string, english: string) => Promise<{ x: number; y: number; w: number; h: number } | null> } = {},
): Promise<DocResponse> {
  if (!validateRequest(body)) throw new BadRequest(new Ajv().errorsText(validateRequest.errors));
  const { events, input } = body;
  const hasDocuments = kb.index.size > 0;
  const allowIdeas = kb.meta.ideas !== false;
  const audience: Audience = live.audience ?? "general";
  if (input.kind === "view" || !hasDocuments) return { events, screen: docScreen(events, hasDocuments, allowIdeas, audience) };
  if (events.length >= MAX_EVENTS) throw new BadRequest("conversation too long");
  // A call ended: its transcript joins the conversation. No model is asked.
  if (input.kind === "call_log") {
    const lines = cleanLines(input.lines);
    const next: DocEvent[] = lines.length ? [...events, { type: "CALL_LOG", call: input.call, lines }] : events;
    return { events: next, screen: docScreen(next, true, allowIdeas, audience) };
  }

  const said = input.text?.trim() || undefined;
  const images = input.images ?? [];
  if (!said && !images.length) throw new BadRequest("empty question");
  const media = images.length ? (input.media === "video" ? "video" : "photo") : undefined;

  const run = await askDocuments(
    client,
    kb.index,
    {
      kbName: kb.meta.name,
      docs: kb.docs,
      question: said,
      images: images.map((i) => ({ type: "image" as const, ...i })),
      media,
      again: images.length > 0 && input.again === true,
      history: events.filter((e): e is DocTurn => e.type === "DOC_TURN").map((e) => ({ said: e.said, result: e.result })),
      earlier: conversationSoFar(events, 1500),
      pageImage: live.pageImage,
      look: live.look && images.length ? (frame, label, english) => (images[frame] ? live.look!(images[frame], label, english) : Promise.resolve(null)) : undefined,
      ideas: allowIdeas,
      audience,
      embedder: live.embedder,
      firstSearch: live.firstSearch,
    },
    progress,
    signal,
    live.onPartial,
  );
  if (run.errors.length) log.warn("ask.model_errors", { kb: kb.meta.id, errors: run.errors.join("; ").slice(0, 500) });
  live.onTiming?.(run.timing);
  // The technician told what solved a fault: their own words are kept for the team, with the
  // question they asked before as the context. The model only said that this is such a message.
  let remembered = false;
  if (run.reported && said && said.length >= 15 && live.remember) {
    const before = [...events].reverse().find((e): e is DocTurn => e.type === "DOC_TURN" && Boolean(e.said) && !e.remembered)?.said;
    remembered = await live.remember(before ? `הקשר: ${before}\nמה פתר: ${said}` : `מה פתר: ${said}`).catch(() => false);
  }
  const event: DocTurn = { type: "DOC_TURN", result: run.result, ...(said ? { said } : {}), ...(media ? { media, frames: images.length } : {}), ...(media && input.again === true ? { again: true as const } : {}), ...(remembered ? { remembered: true as const } : {}) };
  const next = [...events, event];
  return { events: next, screen: docScreen(next, true, allowIdeas, audience) };
}

