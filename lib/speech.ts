// What the assistant says out loud in a call. Built the same way as the chat. Fault-tree
// knowledge bases: KB text and fixed strings only, never model output, never a hazard step.
// Document knowledge bases: the same verified steps the chat shows, and no steps on a hazard topic.
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
      return [item.title, ...item.steps.map((s) => s.text), T.doc.sourceSpoken];
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
