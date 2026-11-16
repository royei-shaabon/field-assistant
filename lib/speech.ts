// What the assistant says out loud in a call. Built the same way as the chat. Fault-tree
// knowledge bases: KB text and fixed strings only, never model output, never a hazard step.
// Document knowledge bases: the same verified steps the chat shows, and no steps on a hazard topic.
// Suggested checks from general knowledge are read after a sentence saying they are not from the manual.
import type { PartialAnswer } from "./docs/ask";
import type { ChatItem, Screen } from "./screen";
import { T } from "./ui-text";

function lineFor(item: ChatItem, screen: Screen): string[] {
  switch (item.kind) {
    case "marked":
      return [T.chat.marked, ...item.marks.map((m) => m.label)];
    case "need_more":
      return [T.chat.needMore, T.chat.retakeTitle, ...T.chat.retake, T.call.sayClosest, ...item.options.map((o) => o.title)];
    case "candidates":
      return [item.list.length > 1 ? T.chat.candidatesMany : T.chat.candidatesOne, ...item.list.map((c) => c.title)];
    case "repeat":
      return [T.chat.repeat];
    case "track_resolved":
      return [item.symptomTitle, T.chat.resolved, item.resolution];
    case "track_closed":
      return [item.symptomTitle, T.chat.closed, item.reason === "tree" && item.detail ? item.detail : item.reason === "step_limit" ? T.chat.stepLimit : T.chat.unclear];
    case "track_stopped":
      return [T.stop.title, T.stop.hazard, T.call.sayUnderstood];
    case "continue":
      return [T.chat.continue, item.symptomTitle];
    case "stopped":
      return item.reason === "danger" ? [T.stop.dangerTitle, T.stop.danger] : [T.ended[item.reason]];
    case "done":
      return [screen.candidates.some((c) => c.status === "resolved") ? T.chat.doneSome : T.chat.doneNone, T.chat.newHint];
    // Document knowledge bases: the verified steps are read out; the sources stay on screen.
    case "doc_answer":
      return [...(item.caution ? [T.doc.cautionTitle, T.doc.topics[item.caution], T.doc.cautionBody] : []), item.title, ...item.steps.map((s) => s.text), T.doc.sourceSpoken, ...(item.ideas?.length ? [T.doc.ideasSpoken, ...item.ideas.map((i) => i.text)] : [])];
    case "doc_ideas":
      return [...(item.caution ? [T.doc.cautionTitle, T.doc.topics[item.caution], T.doc.cautionBody] : []), T.doc.ideasNotFound, T.doc.ideasSpoken, ...item.ideas.map((i) => i.text)];
    case "doc_ask":
      return [item.question, ...(item.options.length ? [T.call.sayClosest, ...item.options] : [])];
    case "doc_hazard":
      return [T.stop.title, T.doc.topics[item.topic], T.doc.hazardBody, item.sources.length ? T.doc.hazardSources : T.doc.hazardNoSources];
    case "doc_not_found":
      return [T.doc.notFound];
    case "doc_error":
      return [T.doc.error];
    case "doc_empty":
      return [T.doc.empty];
    default:
      return []; // the technician's own messages and past questions are not read back
  }
}

// A line as it should be said, not as it is written. On screen an English term sits next to
// the Hebrew one so the technician can find the label; out loud it only breaks the sentence.
const UNITS: [RegExp, string][] = [
  [/(\d)\s*mm\b/g, "$1 מילימטר"],
  [/(\d)\s*cm\b/g, "$1 סנטימטר"],
  [/(\d)\s*km\/h\b/g, "$1 קילומטר לשעה"],
  [/(\d)\s*kPa\b/g, "$1 קילופסקל"],
  [/(\d)\s*psi\b/gi, "$1 פי אס איי"],
  [/(\d)\s*N[·.]?m\b/g, "$1 ניוטון מטר"],
  [/(\d)\s*°C\b/g, "$1 מעלות"],
];
export function forVoice(line: string): string {
  let text = line;
  // "(Fuse box)" after the Hebrew name: dropped. A bracket with Hebrew or only numbers stays.
  text = text.replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => (/[A-Za-z]/.test(inner) && !/[\u0590-\u05ff]/.test(inner) ? "" : whole));
  for (const [pattern, said] of UNITS) text = text.replace(pattern, said);
  return text.replace(/\s+([.,:;!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

// What a call can already say while the answer is still being written: the warning first,
// then the title and every verified step. The caller says only the lines it has not said yet.
export function partialSpeech(partial: PartialAnswer): string[] {
  return [...(partial.caution ? [T.doc.cautionTitle, T.doc.topics[partial.caution], T.doc.cautionBody] : []), partial.title, ...partial.steps.map((s) => s.text)];
}

// What the live model's tool returns: the reply the answer engine gave to one question, as
// data for the model to put into spoken words. Only what the chat shows, nothing more.
export type LiveToolResult =
  | { kind: "answer"; warning?: string; title: string; steps: string[]; suggested_checks_not_from_manual?: string[] }
  | { kind: "suggested_checks_only"; warning?: string; note: string; suggested_checks_not_from_manual: string[] }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "stop"; warning: string; note: string }
  | { kind: "not_found"; note: string }
  | { kind: "error"; note: string };

export function liveToolResult(screen: Screen, from: number): LiveToolResult {
  const caution = (topic?: keyof typeof T.doc.topics) => (topic ? `${T.doc.cautionTitle} ${T.doc.topics[topic]}. ${T.doc.cautionBody}` : undefined);
  for (const item of screen.items.slice(from)) {
    if (item.kind === "doc_answer") {
      const warning = caution(item.caution);
      return { kind: "answer", ...(warning ? { warning } : {}), title: item.title, steps: item.steps.map((s) => forVoice(s.text)), ...(item.ideas?.length ? { suggested_checks_not_from_manual: item.ideas.map((i) => forVoice(i.text)) } : {}) };
    }
    if (item.kind === "doc_ideas") {
      const warning = caution(item.caution);
      return { kind: "suggested_checks_only", ...(warning ? { warning } : {}), note: T.doc.ideasNotFound, suggested_checks_not_from_manual: item.ideas.map((i) => forVoice(i.text)) };
    }
    if (item.kind === "doc_ask") return { kind: "question", question: item.question, options: item.options };
    if (item.kind === "doc_hazard") return { kind: "stop", warning: `${T.stop.title} ${T.doc.topics[item.topic]}`, note: T.doc.hazardBody };
    if (item.kind === "doc_not_found") return { kind: "not_found", note: T.doc.notFound };
    if (item.kind === "doc_error" || item.kind === "doc_empty") return { kind: "error", note: item.kind === "doc_empty" ? T.doc.empty : T.doc.error };
  }
  return { kind: "error", note: T.doc.error };
}

// Lines for the items from `from` on, then the open question (and how to check it).
export function speechFor(screen: Screen, from: number): string[] {
  const lines = screen.items.slice(from).flatMap((item) => lineFor(item, screen));
  if (screen.current) {
    lines.push(screen.current.view.check);
    if (screen.current.view.how) lines.push(screen.current.view.how);
  }
  return lines;
}

// What a call says when it opens on a conversation that is already going: the stop that waits for
// "understood", or the open question.
export function resumeSpeech(screen: Screen): string[] {
  if (screen.mode === "stop") return [T.call.resume, T.stop.title, T.stop.hazard, T.call.sayUnderstood];
  // A document conversation has no open question to repeat: just say the call is on.
  if (!screen.current) return [T.call.greeting];
  return [T.call.resume, ...speechFor(screen, screen.items.length)];
}
