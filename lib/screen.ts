// Builds what the technician screen shows by replaying the event log through the orchestrator.
// Every instruction-like string in a Screen comes from the KB; the rest are T keys or the
// technician's own words. Model output (identify reason, interpret note) is never copied in;
// from the model only candidate ids, confidence and box coordinates are used, and a box's label is
// the KB text of the visual cue it points at.
import type { KnowledgeBase, Outcome, Symptom } from "./kb";
import { answeredCount, initialState, transition, waitingStop, type Event, type State, type StopReason, type Track } from "./orchestrator";
import { validMarks, type Confidence, type StepView } from "./safety";
import type { DocFigure, DocIdea, DocMark, HazardTopic, SourceView } from "./docs/ask";

export type MarkView = { frame: number; box: { x: number; y: number; w: number; h: number }; label: string; symptomTitle: string };

export type ChatItem =
  | { by: "tech"; kind: "text"; said: string }
  | { by: "tech"; kind: "media"; media: "photo" | "video"; frames: number; eventIndex: number; said?: string }
  | { by: "tech"; kind: "picked"; symptomTitle: string }
  | { by: "tech"; kind: "answer"; outcome: "pass" | "fail" | "unclear" | "danger"; said?: string }
  | { by: "tech"; kind: "acknowledged" }
  | { by: "bot"; kind: "marked"; eventIndex: number; marks: MarkView[] }
  | { by: "bot"; kind: "need_more"; options: { symptomId: string; title: string }[] }
  | { by: "bot"; kind: "candidates"; list: { symptomId: string; title: string; confidence: Confidence }[] }
  | { by: "bot"; kind: "asked"; symptomTitle: string; number: number; total: number; check: string }
  | { by: "bot"; kind: "repeat"; symptomTitle: string }
  | { by: "bot"; kind: "track_resolved"; symptomTitle: string; resolution: string }
  | { by: "bot"; kind: "track_closed"; symptomTitle: string; reason: "tree" | "step_limit" | "unclear"; detail?: string }
  | { by: "bot"; kind: "track_stopped"; symptomTitle: string }
  | { by: "bot"; kind: "continue"; symptomTitle: string }
  | { by: "bot"; kind: "stopped"; reason: StopReason; symptomTitle?: string }
  | { by: "bot"; kind: "done"; resolved: number; total: number }
  // Document knowledge bases (lib/docs): an answer whose every step was verified against its source.
  | { by: "bot"; kind: "doc_answer"; eventIndex: number; title: string; steps: { text: string; quote: string; source: SourceView }[]; marks: DocMark[]; figures?: DocFigure[]; caution?: HazardTopic; ideas?: DocIdea[] }
  // Nothing in the documents: suggested checks from general knowledge, marked as such.
  | { by: "bot"; kind: "doc_ideas"; ideas: DocIdea[]; caution?: HazardTopic }
  | { by: "bot"; kind: "doc_ask"; question: string; options: string[] }
  | { by: "bot"; kind: "doc_not_found" }
  | { by: "bot"; kind: "doc_hazard"; topic: HazardTopic; sources: SourceView[] }
  | { by: "bot"; kind: "doc_error" }
  | { by: "bot"; kind: "doc_empty" };

export type CandidateView = {
  symptomId: string;
  title: string;
  confidence: Confidence;
  // halted: still open when the whole conversation stopped.
  status: "open" | "resolved" | "closed" | "stopped" | "halted";
  answered: number;
  total: number;
};

export type CheckView = { symptomId: string; title: string; view: StepView; number: number; total: number; repeat: boolean };

export type Branch = { kind: "step"; stepId: string } | { kind: "resolve"; text: string } | { kind: "escalate"; text: string };

export type TreeNode = {
  stepId: string;
  check?: string; // absent for hazard steps: their text is never shown
  hazard: boolean;
  state: "passed" | "failed" | "current" | "todo" | "stopped";
  answer?: "pass" | "fail";
  pass: Branch;
  fail: Branch;
};

export type TreeView = { symptomId: string; title: string; rootId: string; nodes: TreeNode[] };

export type Screen = {
  items: ChatItem[];
  // identify: waiting for a description, photo or pick; question: `current` is asked;
  // stop: a hazard stop waits for "understood"; done / ended: the conversation is over.
  mode: "identify" | "question" | "stop" | "done" | "ended";
  current?: CheckView;
  pendingStop?: { symptomId: string; title: string };
  candidates: CandidateView[];
  trees: TreeView[];
  title?: string;
  // The whole conversation stopped because the technician reported danger.
  danger: boolean;
};

const branch = (o: Outcome): Branch =>
  typeof o === "string" ? { kind: "step", stepId: o } : "resolve" in o ? { kind: "resolve", text: o.resolve } : { kind: "escalate", text: o.escalate };

function treeView(symptom: Symptom, track: Track | undefined): TreeView {
  const last = new Map<string, "pass" | "fail">();
  for (const h of track?.history ?? []) if (h.outcome === "pass" || h.outcome === "fail") last.set(h.stepId, h.outcome);
  return {
    symptomId: symptom.id,
    title: symptom.title,
    rootId: symptom.steps[0].id,
    nodes: symptom.steps.map((s) => {
      const answer = last.get(s.id);
      const state: TreeNode["state"] =
        track?.status === "stopped" && track.stepId === s.id
          ? "stopped"
          : track?.status === "open" && track.stepId === s.id
            ? "current"
            : answer === "pass"
              ? "passed"
              : answer === "fail"
                ? "failed"
                : "todo";
      return {
        stepId: s.id,
        ...(s.hazard ? {} : { check: s.check }),
        hazard: s.hazard,
        state,
        ...(answer ? { answer } : {}),
        pass: branch(s.on_pass),
        fail: branch(s.on_fail),
      };
    }),
  };
}

// The question asked now: the open track with the fewest answers (ties: identify order), so the
// candidates are checked in turn rather than one to the end.
function currentCheck(kb: KnowledgeBase, tracks: Track[]): CheckView | undefined {
  const open = tracks.filter((t): t is Extract<Track, { status: "open" }> => t.status === "open");
  if (!open.length || waitingStop(tracks)) return undefined;
  const t = open.reduce((a, b) => (answeredCount(b.history) < answeredCount(a.history) ? b : a));
  const symptom = kb.symptoms.get(t.symptomId)!;
  return {
    symptomId: t.symptomId,
    title: symptom.title,
    view: t.view,
    number: answeredCount(t.history) + 1,
    total: symptom.steps.length,
    repeat: t.history.at(-1)?.outcome === "unclear",
  };
}

const MAX_OPTIONS = 4;

export function replay(kb: KnowledgeBase, events: Event[]): { state: State; screen: Screen } {
  let state = initialState();
  const items: ChatItem[] = [];
  const title = (id?: string) => (id ? kb.symptoms.get(id)?.title : undefined);
  const cueCount = (id: string) => kb.symptoms.get(id)?.visual_cues.length;
  let lastIdentify: Extract<Event, { type: "IDENTIFY_RESULT" }> | undefined;

  events.forEach((event, eventIndex) => {
    const before = state;
    state = transition(kb, state, event);
    const tracksNow = "tracks" in state ? state.tracks : [];
    const trackNow = (id: string) => tracksNow.find((t) => t.symptomId === id);

    if (event.type === "IDENTIFY_RESULT") {
      lastIdentify = event;
      const frames = event.frames ?? 0;
      if (event.by === "technician") {
        items.push({ by: "tech", kind: "picked", symptomTitle: title(event.result.candidates[0]?.symptom_id) ?? "" });
      } else if (event.media && frames > 0) {
        items.push({ by: "tech", kind: "media", media: event.media, frames, eventIndex, said: event.said });
        const marks = validMarks(cueCount, event.result, frames).map((m) => ({
          frame: m.frame,
          box: m.box,
          label: kb.symptoms.get(m.symptom_id)!.visual_cues[m.cue],
          symptomTitle: title(m.symptom_id)!,
        }));
        if (marks.length) items.push({ by: "bot", kind: "marked", eventIndex, marks });
      } else {
        items.push({ by: "tech", kind: "text", said: event.said ?? "" });
      }

      if (state.status === "IDENTIFYING") {
        // Offer the model's near misses first, then the rest of the KB.
        const near = event.result.candidates.map((c) => c.symptom_id).filter((id) => kb.symptoms.has(id));
        const ids = [...new Set([...near, ...kb.symptoms.keys()])].slice(0, MAX_OPTIONS);
        items.push({ by: "bot", kind: "need_more", options: ids.map((id) => ({ symptomId: id, title: title(id)! })) });
      }
      if (before.status === "IDENTIFYING" && tracksNow.length) {
        items.push({
          by: "bot",
          kind: "candidates",
          list: tracksNow.map((t) => ({ symptomId: t.symptomId, title: title(t.symptomId)!, confidence: t.confidence })),
        });
        for (const t of tracksNow) if (t.status === "stopped") items.push({ by: "bot", kind: "track_stopped", symptomTitle: title(t.symptomId)! });
      }
    } else if (event.type === "ANSWER" && before.status === "CHECKING") {
      const prev = before.tracks.find((t) => t.symptomId === event.symptomId);
      if (prev?.status === "open" && !waitingStop(before.tracks)) {
        const symptom = kb.symptoms.get(prev.symptomId)!;
        const symptomTitle = symptom.title;
        items.push({ by: "bot", kind: "asked", symptomTitle, number: answeredCount(prev.history) + 1, total: symptom.steps.length, check: prev.view.check });
        items.push({ by: "tech", kind: "answer", outcome: event.outcome, said: event.said });
        const now = trackNow(event.symptomId);
        if (now?.status === "open" && now.stepId === prev.stepId) items.push({ by: "bot", kind: "repeat", symptomTitle });
        if (now?.status === "resolved") items.push({ by: "bot", kind: "track_resolved", symptomTitle, resolution: now.resolution });
        if (now?.status === "closed") items.push({ by: "bot", kind: "track_closed", symptomTitle, reason: now.reason, ...(now.detail ? { detail: now.detail } : {}) });
        if (now?.status === "stopped") items.push({ by: "bot", kind: "track_stopped", symptomTitle });
      }
    } else if (event.type === "ACKNOWLEDGE_STOP" && state.status !== "STOPPED") {
      items.push({ by: "tech", kind: "acknowledged" });
      const next = currentCheck(kb, tracksNow);
      if (next) items.push({ by: "bot", kind: "continue", symptomTitle: next.title });
    }

    if (state.status === "DONE" && before.status !== "DONE") {
      items.push({ by: "bot", kind: "done", resolved: state.tracks.filter((t) => t.status === "resolved").length, total: state.tracks.length });
    }
    if (state.status === "STOPPED" && before.status !== "STOPPED") {
      items.push({ by: "bot", kind: "stopped", reason: state.reason, ...(title(state.symptomId) ? { symptomTitle: title(state.symptomId) } : {}) });
    }
  });

  const tracks = "tracks" in state ? state.tracks : [];
  const candidates: CandidateView[] = tracks.map((t) => ({
    symptomId: t.symptomId,
    title: title(t.symptomId)!,
    confidence: t.confidence,
    status: t.status === "open" && state.status === "STOPPED" ? "halted" : t.status,
    answered: answeredCount(t.history),
    total: kb.symptoms.get(t.symptomId)!.steps.length,
  }));
  const trees = tracks.map((t) => treeView(kb.symptoms.get(t.symptomId)!, t));
  const stopTrack = state.status === "CHECKING" ? waitingStop(tracks) : undefined;
  const current = state.status === "CHECKING" ? currentCheck(kb, tracks) : undefined;

  const mode: Screen["mode"] =
    state.status === "IDENTIFYING" ? "identify" : state.status === "DONE" ? "done" : state.status === "STOPPED" ? "ended" : stopTrack ? "stop" : "question";

  return {
    state,
    screen: {
      items,
      mode,
      ...(current ? { current } : {}),
      ...(stopTrack ? { pendingStop: { symptomId: stopTrack.symptomId, title: title(stopTrack.symptomId)! } } : {}),
      candidates,
      trees,
      title: candidates[0]?.title ?? (lastIdentify?.by === "technician" ? title(lastIdentify.result.candidates[0]?.symptom_id) : undefined),
      danger: state.status === "STOPPED" && state.reason === "danger",
    },
  };
}
