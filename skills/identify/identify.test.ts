// identify: files, runner behaviour and scoring, with a scripted model (no network).
// The live run on fixed photos and texts is `npm run skill-eval`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKnowledgeBase } from "../../lib/kb";
import { initialState, transition } from "../../lib/orchestrator";
import { mentionsHazardTopic } from "../../lib/safety";
import { evalIdentifyPhotos, evalIdentifyText, loadIdentifyTextFixtures } from "../../lib/skills/eval";
import { identify, identifyInput, IDENTIFY_FALLBACK } from "../../lib/skills/identify";
import { loadSkillFiles } from "../../lib/skills/run-skill";
import { FakeModel, lastInput } from "../../tests/helpers/fake-model";
import { assertApiCompatibleSchema, assertExamplesValid, assertNoKbText } from "../../tests/helpers/skill-checks";

const files = loadSkillFiles("identify");
const kb = loadKnowledgeBase();
const ids = [...kb.symptoms.keys()];
const input = identifyInput(kb, "SAMPLE תיאור");
const reply = (o: object) => JSON.stringify(o);
const only = (symptom_id: string, confidence = "high") => ({ candidates: [{ symptom_id, confidence }], reason: "x", marks: [] });
const image = { type: "image" as const, mediaType: "image/jpeg" as const, data: "AAAA" };

test("schema works with structured outputs", () => assertApiCompatibleSchema(files.schema));

test("examples are 5-10 and match the schema", () => assertExamplesValid(files));

test("prompt and examples hold no KB text and no hazard topics", () => {
  assertNoKbText(files);
  assert.ok(!mentionsHazardTopic(files.prompt));
});

test("valid output is returned as is", async () => {
  const model = new FakeModel([reply(only(ids[0]))]);
  const run = await identify(model, input, files);
  assert.deepEqual(run.output, only(ids[0]));
  assert.equal(run.ok, true);
  assert.equal(run.attempts, 1);
});

test("several candidates come back in order", async () => {
  const out = { candidates: [{ symptom_id: ids[1], confidence: "high" }, { symptom_id: ids[0], confidence: "medium" }], reason: "x", marks: [] };
  const run = await identify(new FakeModel([reply(out)]), input, files);
  assert.deepEqual(run.output.candidates.map((c) => c.symptom_id), [ids[1], ids[0]]);
});

test("request: catalog ids as enums, no tools, images before the text with a frame count", async () => {
  const model = new FakeModel([reply(only("unknown", "low"))]);
  await identify(model, { ...input, images: [image, image, image], media: "video" }, files);
  const request = model.requests[0];
  type S = { properties: Record<string, { items: { properties: Record<string, { enum?: string[] }> } }> };
  const props = (request.schema as S).properties;
  assert.deepEqual(props.candidates.items.properties.symptom_id.enum, [...ids, "unknown"]);
  assert.deepEqual(props.marks.items.properties.symptom_id.enum, ids);
  assert.deepEqual(request.content.map((c) => c.type), ["image", "image", "image", "text"]);
  const sent = lastInput(request);
  assert.equal(sent.frames, 3);
  assert.equal(sent.media, "video");
  assert.ok(!("tools" in request));
});

test("the model sees ids, titles and cues only, never steps", async () => {
  const model = new FakeModel([reply(only("unknown", "low"))]);
  await identify(model, input, files);
  const sent = JSON.stringify(model.requests[0].content);
  for (const symptom of kb.symptoms.values()) for (const step of symptom.steps) assert.ok(!sent.includes(step.check));
});

test("marks that do not point at a real frame or cue are dropped, the rest kept", async () => {
  const cues = kb.symptoms.get(ids[0])!.visual_cues.length;
  const good = { frame: 0, symptom_id: ids[0], cue: cues - 1, box: { x: 10, y: 20, w: 300, h: 200 } };
  const out = {
    candidates: [{ symptom_id: ids[0], confidence: "high" }],
    reason: "x",
    marks: [good, { ...good, frame: 4 }, { ...good, cue: cues }, { ...good, symptom_id: ids[1] }, { ...good, box: { x: 900, y: 0, w: 300, h: 10 } }],
  };
  const run = await identify(new FakeModel([reply(out)]), { ...input, images: [image, image] }, files);
  assert.deepEqual(run.output.marks, [good]);
  assert.equal(run.attempts, 1);
});

test("broken output gets one retry", async () => {
  const model = new FakeModel(["not json", reply(only("unknown", "low"))]);
  const run = await identify(model, input, files);
  assert.equal(run.ok, true);
  assert.equal(run.attempts, 2);
});

test("an id outside the catalog, or too many candidates, falls back after a retry", async () => {
  const four = { candidates: ids.slice(0, 4).map((symptom_id) => ({ symptom_id, confidence: "high" })), reason: "x", marks: [] };
  for (const r of [reply(only("made-up")), reply(four), reply({ candidates: [], reason: "x", marks: [] })]) {
    const model = new FakeModel([r]);
    const run = await identify(model, input, files);
    assert.equal(model.requests.length, 2);
    assert.deepEqual(run.output, IDENTIFY_FALLBACK);
    assert.equal(run.ok, false);
  }
});

test("schema violations, refusals and API errors fall back to no candidates", async () => {
  for (const r of [reply({ candidates: [{ symptom_id: "unknown", confidence: "sure" }], reason: "x", marks: [] }), null, new Error("network")]) {
    const run = await identify(new FakeModel([r]), input, files);
    assert.deepEqual(run.output, IDENTIFY_FALLBACK);
  }
});

test("fallback drives the orchestrator to ask for more information, then stop as unidentified", async () => {
  const run = await identify(new FakeModel(["garbage"]), input, files);
  let s = transition(kb, initialState(), { type: "IDENTIFY_RESULT", result: run.output });
  assert.equal(s.status, "IDENTIFYING");
  s = transition(kb, s, { type: "IDENTIFY_RESULT", result: run.output });
  assert.equal(s.status, "STOPPED");
  assert.equal(s.status === "STOPPED" && s.reason, "unidentified");
});

test("text fixtures: perfect answers score 10/10", async () => {
  const fixtures = loadIdentifyTextFixtures();
  const answers = new Map(fixtures.cases.map((c) => [c.description, c]));
  const model = new FakeModel([
    (request) => {
      const c = answers.get(lastInput(request).description as string)!;
      return reply(only(c.expected ?? fixtures.catalog[0].id, c.expected_confidence ?? "high"));
    },
  ]);
  const r = await evalIdentifyText(model, fixtures);
  assert.equal(r.status, "pass");
  assert.equal(r.correct, 10);
});

test("text fixtures: a confident guess on an unclear case is wrong", async () => {
  const fixtures = loadIdentifyTextFixtures();
  const model = new FakeModel([reply(only(fixtures.catalog[0].id))]);
  const r = await evalIdentifyText(model, fixtures);
  const unclear = r.cases.filter((c) => c.expected.includes("(low)"));
  assert.ok(unclear.length >= 3);
  assert.ok(unclear.every((c) => !c.correct));
});

test("photo set is pending until 20 photos exist", async () => {
  const r = await evalIdentifyPhotos(new FakeModel(["{}"]), kb);
  assert.equal(r.status, "pending");
  assert.equal(r.total, 0);
});
