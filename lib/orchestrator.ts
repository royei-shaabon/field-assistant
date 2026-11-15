// Conversation state machine (docs/spec.md, "גבולות האייג'נט", with the changes in CLAUDE.md).
// The model is used at exactly two points, and here only its outputs arrive as events:
// IDENTIFY_RESULT (identify skill) and ANSWER (interpret skill). Everything else is fixed.
//
// IDENTIFYING -> CHECKING -> DONE | STOPPED
// identify may return up to MAX_CANDIDATES symptoms; the technician may also pick one. Each one
// becomes a track that walks its own KB tree. Entering a step always runs presentStep.
//
// Safety:
// - a hazard step on a track stops THAT track. Nothing else can be answered until the technician
//   acknowledges the stop; then the other tracks continue.
// - "danger" in any answer stops the whole conversation (STOPPED).
// - two "unclear" answers in a row close that track.
// When no track is open and no stop waits for acknowledgement: DONE.
// Any event that the current state does not define leads to STOPPED, which is final.
import { getStep, getSymptom, type KnowledgeBase, type Symptom } from "./kb";
import {
  answerGate,
  identifyGate,
  presentStep,
  stepLimitReached,
  type AnswerOutcome,
  type Candidate,
  type IdentifyResult,
  type StepView,
} from "./safety";

export type StopReason =
  | "danger" // interpret returned danger
  | "unidentified" // no symptom from the KB after two attempts
  | "ended" // technician ended the diagnosis
  | "invalid_transition"; // event not defined for the current state

export type HistoryEntry = { stepId: string; outcome: AnswerOutcome; note?: string };

export type Track = {
  symptomId: string;
  confidence: Candidate["confidence"];
  history: HistoryEntry[];
  stepId: string; // current step while open; the last or hazard step otherwise
} & (
  | { status: "open"; view: StepView; unclearStreak: number }
  | { status: "resolved"; resolution: string }
  | { status: "closed"; reason: "tree" | "step_limit" | "unclear"; detail?: string }
  | { status: "stopped"; acknowledged: boolean } // reached a hazard step; its text is never shown
);

export type State =
  | { status: "IDENTIFYING"; attempt: number; needMoreInfo: boolean }
  | { status: "CHECKING"; tracks: Track[] }
  | { status: "DONE"; tracks: Track[] }
  | { status: "STOPPED"; reason: StopReason; symptomId?: string; tracks: Track[] };

// `said`, `media`, `frames` and `by` record what the technician sent, for the transcript only.
// The state machine never reads them.
export type Event =
  | {
      type: "IDENTIFY_RESULT";
      result: IdentifyResult;
      said?: string;
      media?: "photo" | "video";
      frames?: number;
      by?: "technician"; // picked from the list instead of identified by the model
    }
  | { type: "ANSWER"; symptomId: string; outcome: AnswerOutcome; note?: string; said?: string }
  | { type: "ACKNOWLEDGE_STOP"; symptomId: string }
  | { type: "END" };

export function initialState(): State {
  return { status: "IDENTIFYING", attempt: 0, needMoreInfo: false };
}

export function answeredCount(history: HistoryEntry[]): number {
  return history.filter((h) => h.outcome === "pass" || h.outcome === "fail").length;
}

export function waitingStop(tracks: Track[]): Track | undefined {
  return tracks.find((t) => t.status === "stopped" && !t.acknowledged);
}

function stop(reason: StopReason, tracks: Track[], symptomId?: string): State {
  return { status: "STOPPED", reason, tracks, ...(symptomId ? { symptomId } : {}) };
}

// Every step passes through presentStep before it is shown; a hazard step becomes a stop.
function enterStep(
  kb: KnowledgeBase,
  symptom: Symptom,
  stepId: string,
  base: Pick<Track, "symptomId" | "confidence" | "history">,
): Track | null {
  const step = getStep(symptom, stepId);
  if (!step) return null;
  const view = presentStep(kb, symptom, step);
  if (view.kind === "hazard_stop") return { ...base, stepId, status: "stopped", acknowledged: false };
  return { ...base, stepId, status: "open", view, unclearStreak: 0 };
}

function settle(tracks: Track[]): State {
  if (tracks.some((t) => t.status === "open") || waitingStop(tracks)) return { status: "CHECKING", tracks };
  return { status: "DONE", tracks };
}

function identify(kb: KnowledgeBase, state: Extract<State, { status: "IDENTIFYING" }>, result: IdentifyResult): State {
  const attempt = state.attempt + 1;
  const gate = identifyGate(kb, result, attempt);
  if (gate.action === "retry") return { status: "IDENTIFYING", attempt, needMoreInfo: true };
  if (gate.action === "escalate") return stop("unidentified", []);

  const tracks: Track[] = [];
  for (const c of gate.candidates) {
    const symptom = getSymptom(kb, c.symptom_id)!;
    const track = enterStep(kb, symptom, symptom.steps[0].id, { symptomId: symptom.id, confidence: c.confidence, history: [] });
    if (!track) return stop("invalid_transition", tracks, symptom.id);
    tracks.push(track);
  }
  return settle(tracks);
}

function answer(kb: KnowledgeBase, tracks: Track[], event: Extract<Event, { type: "ANSWER" }>): State {
  const index = tracks.findIndex((t) => t.symptomId === event.symptomId);
  const track = tracks[index];
  const symptom = getSymptom(kb, event.symptomId);
  const step = symptom && track && getStep(symptom, track.stepId);
  // A stop must be acknowledged before anything else is answered.
  if (!track || track.status !== "open" || !symptom || !step || waitingStop(tracks)) {
    return stop("invalid_transition", tracks, event.symptomId);
  }

  const history = [...track.history, { stepId: step.id, outcome: event.outcome, note: event.note }];
  const replace = (t: Track) => tracks.map((x, i) => (i === index ? t : x));
  const base = { symptomId: track.symptomId, confidence: track.confidence, history };

  const gate = answerGate(event.outcome, track.unclearStreak);
  if (gate.action === "escalate" && gate.reason === "danger") return stop("danger", replace({ ...track, history }), track.symptomId);
  if (gate.action === "escalate") return settle(replace({ ...base, stepId: step.id, status: "closed", reason: "unclear" }));
  if (gate.action === "repeat") return settle(replace({ ...track, history, unclearStreak: track.unclearStreak + 1 }));

  const outcome = event.outcome === "pass" ? step.on_pass : step.on_fail;
  if (typeof outcome === "object" && "resolve" in outcome) {
    return settle(replace({ ...base, stepId: step.id, status: "resolved", resolution: outcome.resolve }));
  }
  if (typeof outcome === "object" && "escalate" in outcome) {
    return settle(replace({ ...base, stepId: step.id, status: "closed", reason: "tree", detail: outcome.escalate }));
  }
  if (stepLimitReached(symptom, answeredCount(history))) {
    return settle(replace({ ...base, stepId: step.id, status: "closed", reason: "step_limit" }));
  }
  const next = enterStep(kb, symptom, outcome, base);
  if (!next) return stop("invalid_transition", tracks, symptom.id);
  return settle(replace(next));
}

function acknowledge(tracks: Track[], symptomId: string): State {
  const track = tracks.find((t) => t.symptomId === symptomId);
  if (!track || track.status !== "stopped" || track.acknowledged) return stop("invalid_transition", tracks, symptomId);
  return settle(tracks.map((t) => (t === track ? { ...track, acknowledged: true } : t)));
}

export function transition(kb: KnowledgeBase, state: State, event: Event): State {
  // STOPPED is final: later events must not replace the reason.
  if (state.status === "STOPPED") return state;
  const tracks = "tracks" in state ? state.tracks : [];
  if (state.status === "DONE") return stop("invalid_transition", tracks);
  if (event.type === "END") return stop("ended", tracks);

  if (state.status === "IDENTIFYING") {
    return event.type === "IDENTIFY_RESULT" ? identify(kb, state, event.result) : stop("invalid_transition", tracks);
  }
  if (event.type === "ANSWER") return answer(kb, state.tracks, event);
  if (event.type === "ACKNOWLEDGE_STOP") return acknowledge(state.tracks, event.symptomId);
  return stop("invalid_transition", tracks);
}
