// Conversation with a document knowledge base. Same contract as lib/conversation.ts: the client
// keeps only the event log, and the server rebuilds the screen from it on every request.
import Ajv from "ajv";
import { MAX_EVENTS, MAX_IMAGES, MAX_IMAGE_BASE64, MAX_TEXT, BadRequest, type ClientImage } from "../conversation";
import type { ModelClient } from "../llm";
import type { ChatItem, Screen } from "../screen";
import type { DocMeta, KbMeta } from "../store/types";
import { askDocuments, hazardTopic, validDocMarks, type AskProgress, type DocResult } from "./ask";
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
            steps: { type: "array", maxItems: 6, items: obj(["text", "quote", "source"], { text: text(600), quote: text(400), source }) },
            marks: {
              type: "array",
              maxItems: 6,
              items: obj(["frame", "step", "label", "box"], { frame: int, step: int, label: text(40), box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }) }),
            },
          }),
          obj(["kind", "question", "options"], { kind: kind("ask"), question: text(300), options: { type: "array", maxItems: 4, items: text(120) } }),
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
// replay: an answer on a hazard topic gets its warning back, whatever the log says.
function guarded(event: DocEvent): DocResult {
  const r = event.result;
  if (r.kind !== "answer") return r;
  const topic = hazardTopic(event.said, { hazard: "none", steps: r.steps.map((s) => ({ text: s.text, ref: "", quote: s.quote })) });
  const caution = r.caution ?? topic ?? undefined;
  return { ...r, marks: validDocMarks(r.marks, event.frames ?? 0, r.steps.length), ...(caution ? { caution } : {}) };
}

export function docScreen(events: DocEvent[], hasDocuments: boolean): Screen {
  const items: ChatItem[] = [];
  let title: string | undefined;
  events.forEach((event, eventIndex) => {
    if (event.media) items.push({ by: "tech", kind: "media", media: event.media, frames: event.frames ?? 1, eventIndex, said: event.said });
    else if (event.said) items.push({ by: "tech", kind: "text", said: event.said });
    const r = guarded(event);
    if (r.kind === "answer") {
      title ??= r.title;
      items.push({ by: "bot", kind: "doc_answer", eventIndex, title: r.title, steps: r.steps, marks: r.marks, ...(r.caution ? { caution: r.caution } : {}) });
    } else if (r.kind === "ask") items.push({ by: "bot", kind: "doc_ask", question: r.question, options: r.options });
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
): Promise<DocResponse> {
  if (!validateRequest(body)) throw new BadRequest(new Ajv().errorsText(validateRequest.errors));
  const { events, input } = body;
  const hasDocuments = kb.index.size > 0;
  if (input.kind === "view" || !hasDocuments) return { events, screen: docScreen(events, hasDocuments) };
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
    },
    progress,
  );
  if (run.errors.length) console.error(`[ask ${kb.meta.id}]`, run.errors.join("; "));
  const event: DocEvent = { type: "DOC_TURN", result: run.result, ...(said ? { said } : {}), ...(media ? { media, frames: images.length } : {}) };
  const next = [...events, event];
  return { events: next, screen: docScreen(next, true) };
}

