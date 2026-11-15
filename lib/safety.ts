// Safety rules from docs/spec.md ("בטיחות"). Enforced here in code, never in a prompt.
// Every change to this file needs a matching test in tests/safety.test.ts.
import type { KnowledgeBase, Step, Symptom } from "./kb";

export const MAX_IDENTIFY_ATTEMPTS = 2;
export const MAX_UNCLEAR_STREAK = 2;

export const DISCLAIMER = "דמו על ידע לדוגמה. לא הוראות עבודה מאושרות.";

// Topics the spec marks as hazard in advance: brakes and ABS, fuel system, coolant cap on a
// hot engine, any work on a running engine. Used by kb:validate to flag steps for review.
export const HAZARD_TOPICS: { topic: string; pattern: RegExp }[] = [
  { topic: "brakes", pattern: /בלם|בלמים|ABS/i },
  // "דלק" as a word with optional prefix letters, so "נדלק" and "הדלקה" do not match.
  { topic: "fuel", pattern: /(^|[^\u05D0-\u05EA])[בהוכלמש]{0,2}דלק(?![\u05D0-\u05EA])/ },
  { topic: "coolant", pattern: /נוזל קירור|רדיאטור/ },
  // Whole words only: "נורית תקלת המנוע דולקת" is about a lamp, not a running engine.
  { topic: "running-engine", pattern: /מנוע\s+(פועל|מונע|דולק|עובד)(?![\u05D0-\u05EA])/ },
];

export function mentionsHazardTopic(text: string): boolean {
  return HAZARD_TOPICS.some((t) => t.pattern.test(text));
}

export type StepView = {
  kind: "instruction";
  symptomId: string;
  stepId: string;
  check: string;
  how?: string;
  source: { type: Step["source"]["type"]; ref: string; title: string; page?: number };
  tip?: { author: string; text: string };
  conflict: boolean;
};

// A hazard step carries no instruction text at all: the UI shows a stop banner and an
// "escalate to senior" button.
export type HazardStop = { kind: "hazard_stop"; symptomId: string; stepId: string };

// The only way a step reaches the screen. All text is copied from the KB, never generated.
export function presentStep(kb: KnowledgeBase, symptom: Symptom, step: Step): StepView | HazardStop {
  if (step.hazard) return { kind: "hazard_stop", symptomId: symptom.id, stepId: step.id };

  const source = kb.sources.get(step.source.ref);
  if (!source) throw new Error(`source "${step.source.ref}" missing; run kb:validate`);
  return {
    kind: "instruction",
    symptomId: symptom.id,
    stepId: step.id,
    check: step.check,
    ...(step.how ? { how: step.how } : {}),
    source: {
      type: step.source.type,
      ref: step.source.ref,
      title: source.title,
      ...(step.source.page ? { page: step.source.page } : {}),
    },
    ...(step.tip ? { tip: { author: step.tip.author, text: step.tip.text } } : {}),
    conflict: step.conflict === true,
  };
}

export type Confidence = "high" | "medium" | "low";
export type Candidate = { symptom_id: string; confidence: Confidence };

// A box on one of the technician's images (0-1000 on each axis), pointing at visual cue number
// `cue` of `symptom_id`. The label shown next to it is that cue's KB text, never model text.
export type Mark = { frame: number; symptom_id: string; cue: number; box: { x: number; y: number; w: number; h: number } };

export type IdentifyResult = { candidates: Candidate[]; reason?: string; marks?: Mark[] };

export const MAX_CANDIDATES = 3;

// Candidates the orchestrator may open: in the KB, not "unknown", not low confidence, no
// duplicates, at most MAX_CANDIDATES, in the model's order.
export function usableCandidates(kb: KnowledgeBase, result: IdentifyResult): Candidate[] {
  const seen = new Set<string>();
  return result.candidates
    .filter((c) => c.confidence !== "low" && kb.symptoms.has(c.symptom_id) && !seen.has(c.symptom_id) && seen.add(c.symptom_id))
    .slice(0, MAX_CANDIDATES);
}

// No usable candidate: ask for another photo once, then escalate.
export function identifyGate(
  kb: KnowledgeBase,
  result: IdentifyResult,
  attempt: number,
): { action: "proceed"; candidates: Candidate[] } | { action: "retry" } | { action: "escalate" } {
  const candidates = usableCandidates(kb, result);
  if (candidates.length) return { action: "proceed", candidates };
  return attempt >= MAX_IDENTIFY_ATTEMPTS ? { action: "escalate" } : { action: "retry" };
}

// Marks that point at a real image, a candidate symptom and an existing cue, inside the frame.
// `cueCount` returns how many visual cues a symptom has (undefined when it is not in the KB).
export function validMarks(
  cueCount: (symptomId: string) => number | undefined,
  result: IdentifyResult,
  frames: number,
): Mark[] {
  const ids = new Set(result.candidates.map((c) => c.symptom_id));
  const inRange = (v: number) => Number.isInteger(v) && v >= 0 && v <= 1000;
  return (result.marks ?? []).filter((m) => {
    const cues = cueCount(m.symptom_id);
    const { x, y, w, h } = m.box;
    return (
      ids.has(m.symptom_id) && cues !== undefined && Number.isInteger(m.cue) && m.cue >= 0 && m.cue < cues &&
      Number.isInteger(m.frame) && m.frame >= 0 && m.frame < frames &&
      [x, y, w, h].every(inRange) && w > 0 && h > 0 && x + w <= 1000 && y + h <= 1000
    );
  });
}

export type AnswerOutcome = "pass" | "fail" | "unclear" | "danger";

export type AnswerGate =
  | { action: "continue" }
  | { action: "repeat" }
  | { action: "escalate"; reason: "danger" | "unclear" };

// danger escalates immediately; two unclear answers in a row escalate.
export function answerGate(outcome: AnswerOutcome, unclearStreak: number): AnswerGate {
  if (outcome === "danger") return { action: "escalate", reason: "danger" };
  if (outcome === "unclear") {
    return unclearStreak + 1 >= MAX_UNCLEAR_STREAK ? { action: "escalate", reason: "unclear" } : { action: "repeat" };
  }
  return { action: "continue" };
}

// After escalate_after_steps answered steps without a resolution, escalate.
export function stepLimitReached(symptom: Symptom, answeredSteps: number): boolean {
  return answeredSteps >= symptom.escalate_after_steps;
}
