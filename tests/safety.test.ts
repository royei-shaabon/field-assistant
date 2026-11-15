import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerGate,
  identifyGate,
  mentionsHazardTopic,
  presentStep,
  stepLimitReached,
  usableCandidates,
  validMarks,
} from "../lib/safety";
import { fixtureKb, kbStrings } from "./helpers/fixture-kb";

const kb = fixtureKb();
const chain = kb.symptoms.get("sample-chain")!;
const hazardFirst = kb.symptoms.get("sample-hazard-first")!;

test("hazard step is presented as a stop, with no instruction text", () => {
  const view = presentStep(kb, hazardFirst, hazardFirst.steps[0]);
  assert.deepEqual(view, { kind: "hazard_stop", symptomId: "sample-hazard-first", stepId: "s1" });
  const json = JSON.stringify(view);
  assert.ok(!json.includes(hazardFirst.steps[0].check));
  assert.ok(!json.includes(hazardFirst.steps[0].how!));
});

test("instruction view copies KB text and source label", () => {
  const view = presentStep(kb, chain, chain.steps[0]);
  assert.equal(view.kind, "instruction");
  if (view.kind !== "instruction") return;
  assert.equal(view.check, "SAMPLE בדיקה s1");
  assert.equal(view.how, "SAMPLE איך 1");
  assert.deepEqual(view.source, { type: "manual", ref: "sample-manual", title: "SAMPLE מדריך", page: 1 });
  assert.equal(view.tip, undefined);
  assert.equal(view.conflict, false);
});

test("instruction view carries tip author and conflict flag", () => {
  const view = presentStep(kb, chain, chain.steps[1]);
  assert.equal(view.kind, "instruction");
  if (view.kind !== "instruction") return;
  assert.deepEqual(view.tip, { author: "SAMPLE מכונאי", text: "SAMPLE טיפ 2" });
  assert.equal(view.conflict, true);
});

test("every string in an instruction view exists in the KB", () => {
  const allowed = kbStrings(kb);
  for (const symptom of kb.symptoms.values()) {
    for (const step of symptom.steps) {
      const view = presentStep(kb, symptom, step);
      const walk = (v: unknown): void => {
        if (typeof v === "string") assert.ok(allowed.has(v) || v === "instruction" || v === "hazard_stop", v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(view);
    }
  }
});

const one = (symptom_id: string, confidence: "high" | "medium" | "low" = "high") => ({
  candidates: [{ symptom_id, confidence }],
});

test("identify: high and medium candidates proceed", () => {
  assert.deepEqual(identifyGate(kb, one("sample-chain"), 1), {
    action: "proceed",
    candidates: [{ symptom_id: "sample-chain", confidence: "high" }],
  });
  assert.equal(identifyGate(kb, one("sample-chain", "medium"), 1).action, "proceed");
});

test("identify: low, unknown or an id outside the KB retries once, then escalates", () => {
  for (const result of [one("sample-chain", "low"), one("unknown"), one("not-in-kb"), { candidates: [] }]) {
    assert.deepEqual(identifyGate(kb, result, 1), { action: "retry" });
    assert.deepEqual(identifyGate(kb, result, 2), { action: "escalate" });
  }
});

test("identify: usable candidates drop low, unknown and duplicates, keep order, max 3", () => {
  const result = {
    candidates: [
      { symptom_id: "sample-short", confidence: "medium" as const },
      { symptom_id: "unknown", confidence: "high" as const },
      { symptom_id: "sample-chain", confidence: "low" as const },
      { symptom_id: "sample-short", confidence: "high" as const },
      { symptom_id: "sample-chain", confidence: "high" as const },
      { symptom_id: "sample-hazard-first", confidence: "high" as const },
      { symptom_id: "sample-hazard-second", confidence: "high" as const },
    ],
  };
  assert.deepEqual(
    usableCandidates(kb, result).map((c) => c.symptom_id),
    ["sample-short", "sample-chain", "sample-hazard-first"],
  );
});

test("marks: only boxes on a real frame, a candidate and an existing cue survive", () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  const result = {
    candidates: [{ symptom_id: "sample-short", confidence: "high" as const }],
    marks: [
      { frame: 0, symptom_id: "sample-short", cue: 1, box },
      { frame: 2, symptom_id: "sample-short", cue: 0, box }, // no such frame
      { frame: 0, symptom_id: "sample-chain", cue: 0, box }, // not a candidate
      { frame: 0, symptom_id: "sample-short", cue: 5, box }, // no such cue
      { frame: 0, symptom_id: "sample-short", cue: 0, box: { x: 900, y: 0, w: 200, h: 10 } }, // off the image
      { frame: 0, symptom_id: "sample-short", cue: 0, box: { x: 0, y: 0, w: 0, h: 10 } }, // empty
    ],
  };
  assert.deepEqual(validMarks((id) => kb.symptoms.get(id)?.visual_cues.length, result, 2), [result.marks[0]]);
});

test("answer: danger escalates at once", () => {
  assert.deepEqual(answerGate("danger", 0), { action: "escalate", reason: "danger" });
});

test("answer: first unclear repeats, second in a row escalates", () => {
  assert.deepEqual(answerGate("unclear", 0), { action: "repeat" });
  assert.deepEqual(answerGate("unclear", 1), { action: "escalate", reason: "unclear" });
});

test("answer: pass and fail continue", () => {
  assert.deepEqual(answerGate("pass", 1), { action: "continue" });
  assert.deepEqual(answerGate("fail", 0), { action: "continue" });
});

test("step limit uses escalate_after_steps", () => {
  assert.equal(stepLimitReached(chain, 2), false);
  assert.equal(stepLimitReached(chain, 3), true);
});

test("hazard topics are detected", () => {
  for (const text of ["בדיקת בלמים", "נורית ABS", "צינור דלק", "ריח של דלק", "מיכל הדלק", "פתיחת מכסה נוזל קירור", "כשהמנוע פועל", "מנוע פועל"]) {
    assert.ok(mentionsHazardTopic(text), text);
  }
  for (const text of ["SAMPLE בדיקה", "בדיקת מתח מצבר", "מפתח חכם", "המנוע לא נדלק", "הדלקה", "נורית דולקת", "האם נורית תקלת המנוע דולקת?"]) {
    assert.ok(!mentionsHazardTopic(text), text);
  }
});
