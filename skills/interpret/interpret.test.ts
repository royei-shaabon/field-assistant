// interpret: files, runner behaviour and scoring, with a scripted model (no network).
// The live run on the 30 fixed answers is `npm run skill-eval -- interpret`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, transition } from "../../lib/orchestrator";
import { evalInterpret, loadInterpretFixtures } from "../../lib/skills/eval";
import { interpret, interpretInput, INTERPRET_FALLBACK } from "../../lib/skills/interpret";
import { loadSkillFiles } from "../../lib/skills/run-skill";
import { fixtureKb } from "../../tests/helpers/fixture-kb";
import { FakeModel, lastInput } from "../../tests/helpers/fake-model";
import { assertApiCompatibleSchema, assertExamplesValid, assertNoKbText } from "../../tests/helpers/skill-checks";

const files = loadSkillFiles("interpret");
const step = { check: "SAMPLE בדיקה", how: "SAMPLE איך" };
const reply = (o: object) => JSON.stringify(o);

test("schema works with structured outputs", () => assertApiCompatibleSchema(files.schema));

test("examples are 5-10 and match the schema", () => assertExamplesValid(files));

test("prompt and examples hold no KB text", () => assertNoKbText(files));

test("the model sees check, how and the answer, never the tree", async () => {
  const model = new FakeModel([reply({ outcome: "pass", note: "x" })]);
  const fullStep = fixtureKb().symptoms.get("sample-chain")!.steps[0];
  await interpret(model, interpretInput(fullStep, "כן"), files);
  assert.deepEqual(Object.keys(lastInput(model.requests[0])).sort(), ["answer", "check", "how"]);
});

test("valid output is returned as is", async () => {
  const run = await interpret(new FakeModel([reply({ outcome: "danger", note: "עשן" })]), interpretInput(step, "x"), files);
  assert.deepEqual(run.output, { outcome: "danger", note: "עשן" });
  assert.equal(run.ok, true);
});

test("broken output gets one retry, then falls back to unclear", async () => {
  const retried = await interpret(new FakeModel(["{", reply({ outcome: "fail", note: "" })]), interpretInput(step, "x"), files);
  assert.equal(retried.output.outcome, "fail");
  assert.equal(retried.attempts, 2);

  for (const r of [reply({ outcome: "skip", note: "" }), reply({ outcome: "pass" }), null, new Error("timeout")]) {
    const model = new FakeModel([r]);
    const run = await interpret(model, interpretInput(step, "x"), files);
    assert.deepEqual(run.output, INTERPRET_FALLBACK);
    assert.equal(model.requests.length, 2);
  }
});

test("two fallbacks in a row close the check through the orchestrator", async () => {
  const kb = fixtureKb();
  let s = transition(kb, initialState(), { type: "IDENTIFY_RESULT", result: { candidates: [{ symptom_id: "sample-chain", confidence: "high" }] } });
  for (let i = 0; i < 2; i++) {
    const run = await interpret(new FakeModel(["garbage"]), interpretInput(step, "x"), files);
    s = transition(kb, s, { type: "ANSWER", symptomId: "sample-chain", outcome: run.output.outcome, note: run.output.note });
  }
  assert.equal(s.status, "DONE");
  const t = s.status === "DONE" ? s.tracks[0] : undefined;
  assert.equal(t?.status === "closed" && t.reason, "unclear");
});

test("fixtures: 30 cases, every outcome covered, no overlap with examples", () => {
  const fixtures = loadInterpretFixtures();
  assert.equal(fixtures.cases.length, 30);
  for (const c of fixtures.cases) {
    assert.ok(fixtures.checks[c.check], `unknown check ${c.check}`);
    assert.ok(["pass", "fail", "unclear", "danger"].includes(c.expected));
  }
  for (const o of ["pass", "fail", "unclear", "danger"]) {
    assert.ok(fixtures.cases.filter((c) => c.expected === o).length >= 3, `need >= 3 ${o} cases`);
  }
  const exampleAnswers = new Set(files.examples.map((e) => (e.input as { answer: string }).answer));
  const exampleChecks = new Set(files.examples.map((e) => (e.input as { check: string }).check));
  for (const c of fixtures.cases) assert.ok(!exampleAnswers.has(c.answer), c.answer);
  for (const check of Object.values(fixtures.checks)) assert.ok(!exampleChecks.has(check), check);
});

test("scoring: 27/30 passes, 26/30 fails", async () => {
  const fixtures = loadInterpretFixtures();
  const scoreWithWrong = async (wrong: number) => {
    let n = 0;
    const model = new FakeModel([
      (request) => {
        const c = fixtures.cases.find((x) => x.answer === lastInput(request).answer)!;
        const outcome = n++ < wrong ? (c.expected === "pass" ? "fail" : "pass") : c.expected;
        return reply({ outcome, note: "" });
      },
    ]);
    return evalInterpret(model, fixtures);
  };
  const ok = await scoreWithWrong(3);
  assert.equal(ok.correct, 27);
  assert.equal(ok.status, "pass");
  const bad = await scoreWithWrong(4);
  assert.equal(bad.correct, 26);
  assert.equal(bad.status, "fail");
});
