// Server side of POST /api/conversation. The client keeps only the event log; every request
// replays it through the orchestrator, so a forged log can never put a hazard step on screen.
import Ajv from "ajv";
import type { KnowledgeBase } from "./kb";
import { getStep, getSymptom } from "./kb";
import type { ModelClient } from "./llm";
import { waitingStop, type Event } from "./orchestrator";
import { replay, type Screen } from "./screen";
import { identify, identifyInput } from "./skills/identify";
import { interpret, interpretInput } from "./skills/interpret";

export const MAX_EVENTS = 80;
export const MAX_TEXT = 500;
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BASE64 = 1_500_000;

export type ClientImage = { mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string };

export type ClientInput =
  | { kind: "view" }
  | { kind: "describe"; text?: string; images?: ClientImage[]; media?: "photo" | "video" }
  | { kind: "answer"; symptomId: string; outcome: "pass" | "fail" | "unclear" }
  | { kind: "text"; text: string; symptomId?: string }
  | { kind: "pick"; symptomId: string } // the technician picks a symptom from the list
  | { kind: "acknowledge"; symptomId: string } // "understood" on a hazard stop
  | { kind: "end" };

// Progress the server reports while it works, so the chat can show it live.
export type Progress = "reading" | "looking" | "matching" | "interpreting" | "choosing" | "searching" | "pages" | "writing" | "checking";

export type ConversationRequest = { events: Event[]; input: ClientInput };
export type ConversationResponse = { events: Event[]; screen: Screen };

export class BadRequest extends Error {}

const text = { type: "string", maxLength: MAX_TEXT };
const id = { type: "string", maxLength: 100 };
const int = { type: "integer", minimum: 0, maximum: 1000 };
const obj = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const requestSchema = obj(["events", "input"], {
  events: {
    type: "array",
    maxItems: MAX_EVENTS,
    items: {
      oneOf: [
        obj(["type", "result"], {
          type: { const: "IDENTIFY_RESULT" },
          said: text,
          media: { enum: ["photo", "video"] },
          frames: { type: "integer", minimum: 0, maximum: MAX_IMAGES },
          by: { const: "technician" },
          result: obj(["candidates"], {
            candidates: {
              type: "array",
              maxItems: 10,
              items: obj(["symptom_id", "confidence"], { symptom_id: id, confidence: { enum: ["high", "medium", "low"] } }),
            },
            reason: text,
            marks: {
              type: "array",
              maxItems: 20,
              items: obj(["frame", "symptom_id", "cue", "box"], {
                frame: int,
                symptom_id: id,
                cue: int,
                box: obj(["x", "y", "w", "h"], { x: int, y: int, w: int, h: int }),
              }),
            },
          }),
        }),
        obj(["type", "symptomId", "outcome"], {
          type: { const: "ANSWER" },
          symptomId: id,
          outcome: { enum: ["pass", "fail", "unclear", "danger"] },
          note: text,
          said: text,
        }),
        obj(["type", "symptomId"], { type: { const: "ACKNOWLEDGE_STOP" }, symptomId: id }),
        obj(["type"], { type: { const: "END" } }),
      ],
    },
  },
  input: {
    oneOf: [
      obj(["kind"], { kind: { const: "view" } }),
      obj(["kind"], {
        kind: { const: "describe" },
        text,
        media: { enum: ["photo", "video"] },
        images: {
          type: "array",
          minItems: 1,
          maxItems: MAX_IMAGES,
          items: obj(["mediaType", "data"], {
            mediaType: { enum: ["image/jpeg", "image/png", "image/webp"] },
            data: { type: "string", maxLength: MAX_IMAGE_BASE64 },
          }),
        },
      }),
      obj(["kind", "symptomId", "outcome"], { kind: { const: "answer" }, symptomId: id, outcome: { enum: ["pass", "fail", "unclear"] } }),
      obj(["kind", "text"], { kind: { const: "text" }, text: { ...text, minLength: 1 }, symptomId: id }),
      obj(["kind", "symptomId"], { kind: { const: "pick" }, symptomId: id }),
      obj(["kind", "symptomId"], { kind: { const: "acknowledge" }, symptomId: id }),
      obj(["kind"], { kind: { const: "end" } }),
    ],
  },
});

const validateRequest = new Ajv().compile<ConversationRequest>(requestSchema);

// Plain one-word answers need no model: the whole message must be exactly one of these.
// Anything longer (including any mention of smoke, smells, leaks) goes to interpret.
const QUICK: Record<string, "pass" | "fail" | "unclear"> = {
  "כן": "pass",
  "כן כן": "pass",
  "נכון": "pass",
  "yes": "pass",
  "לא": "fail",
  "לא לא": "fail",
  "no": "fail",
  "לא יודע": "unclear",
  "לא יודעת": "unclear",
  "לא בטוח": "unclear",
  "לא בטוחה": "unclear",
  "לא ברור": "unclear",
};

const normalize = (text: string) => text.trim().toLowerCase().replace(/[.,!?״"'׳]/g, "").replace(/\s+/g, " ");

export function quickAnswer(text: string): "pass" | "fail" | "unclear" | null {
  return QUICK[normalize(text)] ?? null;
}

export function isAcknowledgement(text: string): boolean {
  return /^(הבנתי|הבנו|הבנתי לא נוגע בזה|ok|אוקיי|בסדר הבנתי)$/.test(normalize(text));
}

// Turns the client's input into the next event. Model calls happen only here.
async function nextEvent(
  kb: KnowledgeBase,
  client: ModelClient,
  events: Event[],
  input: ClientInput,
  progress: (p: Progress) => void,
): Promise<Event | null> {
  if (input.kind === "view") return null;
  if (input.kind === "end") return { type: "END" };
  if (input.kind === "answer") return { type: "ANSWER", symptomId: input.symptomId, outcome: input.outcome };
  if (input.kind === "acknowledge") return { type: "ACKNOWLEDGE_STOP", symptomId: input.symptomId };
  if (input.kind === "pick") {
    // Only a symptom from the KB can be picked; anything else is left to the orchestrator to refuse.
    const known = kb.symptoms.has(input.symptomId);
    return {
      type: "IDENTIFY_RESULT",
      result: { candidates: known ? [{ symptom_id: input.symptomId, confidence: "high" }] : [] },
      by: "technician",
    };
  }

  const { state } = replay(kb, events);

  // Text before a symptom is known is a description; after, it is an answer.
  if (input.kind === "describe" || state.status === "IDENTIFYING") {
    const said = input.text?.trim() || undefined;
    const images = input.kind === "describe" ? (input.images ?? []) : [];
    const media = images.length ? (input.kind === "describe" && input.media === "video" ? "video" : "photo") : undefined;
    progress(images.length ? "looking" : "reading");
    const run = await identify(
      client,
      identifyInput(kb, said, images.map((i) => ({ type: "image" as const, ...i })), media),
    );
    progress("matching");
    return { type: "IDENTIFY_RESULT", result: run.output, said, ...(media ? { media, frames: images.length } : {}) };
  }

  if (state.status === "CHECKING") {
    // A hazard stop waits for "understood", typed or spoken. Anything else changes nothing.
    const stopped = waitingStop(state.tracks);
    if (stopped) return isAcknowledgement(input.text) ? { type: "ACKNOWLEDGE_STOP", symptomId: stopped.symptomId } : null;

    const { screen } = replay(kb, events);
    // Free text answers the question on screen; a client may name another open check.
    const open = state.tracks.filter((t) => t.status === "open");
    const track = open.find((t) => t.symptomId === input.symptomId) ?? open.find((t) => t.symptomId === screen.current?.symptomId) ?? open[0];
    if (!track) return { type: "ANSWER", symptomId: input.symptomId ?? "", outcome: "unclear", said: input.text };
    const quick = quickAnswer(input.text);
    if (quick) return { type: "ANSWER", symptomId: track.symptomId, outcome: quick, said: input.text };
    const step = getStep(getSymptom(kb, track.symptomId)!, track.stepId)!;
    progress("interpreting");
    const run = await interpret(client, interpretInput(step, input.text));
    return { type: "ANSWER", symptomId: track.symptomId, outcome: run.output.outcome, note: run.output.note, said: input.text };
  }

  // Text after the conversation ended: no model call, the orchestrator decides.
  return { type: "ANSWER", symptomId: input.symptomId ?? "", outcome: "unclear", said: input.text };
}

export async function handleConversation(
  kb: KnowledgeBase,
  client: ModelClient,
  body: unknown,
  progress: (p: Progress) => void = () => {},
): Promise<ConversationResponse> {
  if (!validateRequest(body)) throw new BadRequest(new Ajv().errorsText(validateRequest.errors));
  const event = await nextEvent(kb, client, body.events, body.input, progress);
  const events = event ? [...body.events, event] : body.events;
  if (events.length > MAX_EVENTS) throw new BadRequest("conversation too long");
  if (event && event.type !== "ANSWER") progress("choosing");
  return { events, screen: replay(kb, events).screen };
}
