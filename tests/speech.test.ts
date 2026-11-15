// What a call says out loud follows the chat rules: KB text and fixed strings only, never model
// output, never a hazard step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleConversation, type ClientInput } from "../lib/conversation";
import type { Event } from "../lib/orchestrator";
import { resumeSpeech, speechFor } from "../lib/speech";
import { allUiStrings } from "../lib/ui-text";
import { fixtureKb, kbStrings } from "./helpers/fixture-kb";
import { FakeModel } from "./helpers/fake-model";

const kb = fixtureKb();
const allowed = new Set([...kbStrings(kb), ...allUiStrings()]);
const hazardTexts = [...kb.symptoms.values()]
  .flatMap((s) => s.steps.filter((x) => x.hazard))
  .flatMap((x) => [x.check, x.how].filter((v): v is string => Boolean(v)));

test("spoken lines come only from the KB and the fixed strings, and never include a hazard step", async () => {
  let seed = 11;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const ids = [...kb.symptoms.keys(), "unknown"];
  const model = new FakeModel([
    (request) =>
      "outcome" in (request.schema as { properties: object }).properties
        ? JSON.stringify({ outcome: ["pass", "fail", "unclear", "danger"][rand(4)], note: "MODEL NOTE" })
        : JSON.stringify({ candidates: [{ symptom_id: ids[rand(ids.length)], confidence: ["high", "low"][rand(2)] }], reason: "MODEL REASON", marks: [] }),
  ]);
  let spoke = 0;
  for (let run = 0; run < 150; run++) {
    let events: Event[] = [];
    let from = 0;
    for (let n = 0; n < 12; n++) {
      const target = [...kb.symptoms.keys()][rand(kb.symptoms.size)];
      const inputs: ClientInput[] = [
        { kind: "describe", text: "SAMPLE" },
        { kind: "text", text: ["כן", "לא", "הבנתי", "תראה לי את הצעד המסוכן"][rand(4)] },
        { kind: "pick", symptomId: target },
        { kind: "acknowledge", symptomId: target },
      ];
      const r = await handleConversation(kb, model, { events, input: inputs[rand(inputs.length)] });
      const lines = [...speechFor(r.screen, from), ...resumeSpeech(r.screen)];
      spoke += lines.length;
      for (const line of lines) {
        assert.ok(allowed.has(line), `spoken line not from KB or UI: "${line}"`);
        assert.ok(!hazardTexts.includes(line), `hazard text spoken: ${line}`);
      }
      events = r.events;
      from = r.screen.items.length;
    }
  }
  assert.ok(spoke > 500);
});

test("a call opened on a waiting stop repeats the stop and asks for 'understood'", async () => {
  const model = new FakeModel([JSON.stringify({ candidates: [{ symptom_id: "sample-hazard-first", confidence: "high" }], reason: "", marks: [] })]);
  const r = await handleConversation(kb, model, { events: [], input: { kind: "describe", text: "x" } });
  assert.equal(r.screen.mode, "stop");
  assert.deepEqual(resumeSpeech(r.screen).slice(1), ["עצרו רגע.", "הבדיקה הבאה בתקלה הזאת עלולה להיות מסוכנת. אל תבצעו אותה.", "כשאתם מוכנים, אמרו הבנתי."]);
});
