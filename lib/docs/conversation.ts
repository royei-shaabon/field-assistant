// Conversation with a document knowledge base. Same contract as lib/conversation.ts: the client
// keeps only the event log, and the server rebuilds the screen from it on every request.
import Ajv from "ajv";
import { MAX_EVENTS, MAX_IMAGES, MAX_IMAGE_BASE64, MAX_TEXT, BadRequest, type ClientImage } from "../conversation";
import type { ModelClient } from "../llm";
import type { ChatItem, Screen } from "../screen";
import type { DocMeta, KbMeta } from "../store/types";
import { askDocuments, hazardTopic, rankIdeas, validDocMarks, type AskInput, type AskProgress, type DocResult, type PartialAnswer } from "./ask";
import type { Embedder } from "./embed";
import type { SearchIndex } from "./search";

export type DocEvent = { type: "DOC_TURN"; said?: string; media?: "photo" | "video"; frames?: number; result: DocResult };

export type DocInput = { kind: "view" } | { kind: "ask"; text?: string; images?: ClientImage[]; media?: "photo" | "video" };

export type DocRequest = { events: DocEvent[]; input: DocInput };
export type DocResponse = { events: DocEvent[]; screen: Screen };

const text = (max = MAX_TEXT) => ({ type: "string", maxLength: max });
const int = { type: "integer", minimum: 0, maximum: 1000 };
const obj = (required: string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required, properties });
const source = obj(["docId", "docName", "origin", "unit", "n"], {
  docId: text(80),
  docName: text(200),
  origin: { enum: ["manufacturer", "customer"] },
  unit: { enum: ["page", "part"] },
  n: { type: "integer", minimum: 1 },
});
const kind = (k: string) => ({ const: k });
const ideas = {
  type: "array",
  maxItems: 4,
  items: obj(["text", "why", "likelihood", "minutes"], { text: text(300), why: text(300), likelihood: { enum: ["high", "medium", "low"] }, minutes: { type: "integer", minimum: 1, maximum: 240 } }),
};

const requestSchema = obj(["events", "input"], {
  events: {
    type: "array",
    maxItems: MAX_EVENTS,
    items: obj(["type", "result"], {
      type: kind("DOC_TURN"),
      said: text(),
      media: { enum: ["photo", "video"] },
      frames: { type: "integer", minimum: 0, maximum: MAX_IMAGES },
      result: {
        oneOf: [
          obj(["kind", "title", "steps", "marks"], {
            kind: kind("answer"),
            caution: { enum: ["brakes", "fuel", "hot_coolant", "running_engine", "other"] },
            title: text(80),
            ideas,
            steps: { type: "array", maxItems: 6, items: obj(["text", "quote", "source"], { text: text(600), quote: text(400), source }) },
            figures: {
              type: "array",
              maxItems: 2,
              items: obj(["source", "caption", "box", "aspect"], { source, caption: text(80), box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }), aspect: { type: "number", minimum: 0.2, maximum: 5 } }),
            },
            marks: {
              type: "array",
              maxItems: 6,
              items: obj(["frame", "step", "label", "box"], { frame: int, step: int, label: text(40), box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }) }),
            },
          }),
          obj(["kind", "question", "options"], { kind: kind("ask"), question: text(300), options: { type: "array", maxItems: 4, items: text(120) } }),
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
    }),
  },
  input: {
    oneOf: [
      obj(["kind"], { kind: kind("view") }),
      obj(["kind"], {
        kind: kind("ask"),
        text: text(),
        media: { enum: ["photo", "video"] },
        images: {
          type: "array",
          minItems: 1,
          maxItems: MAX_IMAGES,
          items: obj(["mediaType", "data"], { mediaType: { enum: ["image/jpeg", "image/png", "image/webp"] }, data: { type: "string", maxLength: MAX_IMAGE_BASE64 } }),
        },
      }),
    ],
  },
});

const validateRequest = new Ajv().compile<DocRequest>(requestSchema);

// The event log comes back from the client, so the hazard rule is applied again on every
// replay: anything on a hazard topic gets its warning back, whatever the log says, and
// suggested checks are dropped when the knowledge base turned them off.
function guarded(event: DocEvent, allowIdeas: boolean): DocResult {
  const r = event.result;
  if (r.kind === "ideas") {
    const caution = r.caution ?? hazardTopic(event.said, { hazard: "none", steps: [], checks: r.ideas }) ?? undefined;
    const kept = allowIdeas ? rankIdeas(r.ideas) : [];
    if (kept.length) return { kind: "ideas", ideas: kept, ...(caution ? { caution } : {}) };
    return caution ? { kind: "hazard", topic: caution, sources: [] } : { kind: "not_found" };
  }
  if (r.kind !== "answer") return r;
  const topic = hazardTopic(event.said, { hazard: "none", steps: r.steps.map((s) => ({ text: s.text, ref: "", quote: s.quote })), checks: r.ideas });
  const caution = r.caution ?? topic ?? undefined;
  const { ideas: logged, ...rest } = r;
  const kept = allowIdeas ? rankIdeas(logged) : [];
  return { ...rest, marks: validDocMarks(r.marks, event.frames ?? 0, r.steps.length), ...(caution ? { caution } : {}), ...(kept.length ? { ideas: kept } : {}) };
}

export function docScreen(events: DocEvent[], hasDocuments: boolean, allowIdeas = true): Screen {
  const items: ChatItem[] = [];
  let title: string | undefined;
  events.forEach((event, eventIndex) => {
    if (event.media) items.push({ by: "tech", kind: "media", media: event.media, frames: event.frames ?? 1, eventIndex, said: event.said });
    else if (event.said) items.push({ by: "tech", kind: "text", said: event.said });
    const r = guarded(event, allowIdeas);
    if (r.kind === "answer") {
      title ??= r.title;
      items.push({ by: "bot", kind: "doc_answer", eventIndex, title: r.title, steps: r.steps, marks: r.marks, ...(r.figures?.length ? { figures: r.figures } : {}), ...(r.caution ? { caution: r.caution } : {}), ...(r.ideas?.length ? { ideas: r.ideas } : {}) });
    } else if (r.kind === "ideas") items.push({ by: "bot", kind: "doc_ideas", ideas: r.ideas, ...(r.caution ? { caution: r.caution } : {}) });
    else if (r.kind === "ask") items.push({ by: "bot", kind: "doc_ask", question: r.question, options: r.options });
    else if (r.kind === "hazard") items.push({ by: "bot", kind: "doc_hazard", topic: r.topic, sources: r.sources });
    else if (r.kind === "not_found") items.push({ by: "bot", kind: "doc_not_found" });
    else items.push({ by: "bot", kind: "doc_error" });
  });
  if (!hasDocuments) items.push({ by: "bot", kind: "doc_empty" });
  title ??= events.find((e) => e.said)?.said?.slice(0, 40);
  return { items, mode: "identify", candidates: [], trees: [], title, danger: false };
}

export async function handleDocConversation(
  kb: { meta: KbMeta; docs: DocMeta[]; index: SearchIndex },
  client: ModelClient,
  body: unknown,
  progress: (p: AskProgress) => void = () => {},
  signal?: AbortSignal,
  // Live view of the answer while it is written, and the renderer of manual pages.
  live: { onPartial?: (p: PartialAnswer) => void; pageImage?: AskInput["pageImage"]; embedder?: Embedder | null } = {},
): Promise<DocResponse> {
  if (!validateRequest(body)) throw new BadRequest(new Ajv().errorsText(validateRequest.errors));
  const { events, input } = body;
  const hasDocuments = kb.index.size > 0;
  const allowIdeas = kb.meta.ideas !== false;
  if (input.kind === "view" || !hasDocuments) return { events, screen: docScreen(events, hasDocuments, allowIdeas) };
  if (events.length >= MAX_EVENTS) throw new BadRequest("conversation too long");

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
      history: events.map((e) => ({ said: e.said, result: e.result })),
      pageImage: live.pageImage,
      ideas: allowIdeas,
      embedder: live.embedder,
    },
    progress,
    signal,
    live.onPartial,
  );
  if (run.errors.length) console.error(`[ask ${kb.meta.id}]`, run.errors.join("; "));
  const event: DocEvent = { type: "DOC_TURN", result: run.result, ...(said ? { said } : {}), ...(media ? { media, frames: images.length } : {}) };
  const next = [...events, event];
  return { events: next, screen: docScreen(next, true, allowIdeas) };
}

