// POST /api/conversation logic, with a scripted model. The route itself only adds the stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BadRequest, handleConversation, isAcknowledgement, quickAnswer, type ClientInput, type ConversationResponse, type Progress } from "../lib/conversation";
import type { Event } from "../lib/orchestrator";
import { fixtureKb } from "./helpers/fixture-kb";
import { FakeModel } from "./helpers/fake-model";

const kb = fixtureKb();
const REASON = "SAMPLE-MODEL-REASON-SHOULD-NOT-RENDER";
const NOTE = "SAMPLE-MODEL-NOTE-SHOULD-NOT-RENDER";
const image = { mediaType: "image/jpeg" as const, data: "AAAA" };

const identifies = (ids: string[], confidence = "high", marks: object[] = []) =>
  JSON.stringify({ candidates: ids.map((symptom_id) => ({ symptom_id, confidence })), reason: REASON, marks });
const interprets = (outcome: string) => JSON.stringify({ outcome, note: NOTE });

async function call(model: FakeModel, events: Event[], input: ClientInput, progress?: (p: Progress) => void): Promise<ConversationResponse> {
  return handleConversation(kb, model, { events, input }, progress);
}

test("empty conversation waits for a description", async () => {
  const { screen, events } = await call(new FakeModel(["{}"]), [], { kind: "view" });
  assert.deepEqual(events, []);
  assert.equal(screen.mode, "identify");
  assert.deepEqual([screen.items, screen.candidates, screen.trees], [[], [], []]);
});

test("description -> candidates -> one question at a time, rotating between candidates", async () => {
  const model = new FakeModel([identifies(["sample-chain", "sample-short"])]);
  let r = await call(model, [], { kind: "describe", text: "SAMPLE תיאור" });
  assert.equal(r.screen.mode, "question");
  assert.equal(r.screen.title, "SAMPLE שרשרת");
  assert.deepEqual(r.screen.items.map((i) => i.kind), ["text", "candidates"]);
  assert.deepEqual([r.screen.current?.symptomId, r.screen.current?.number, r.screen.current?.total], ["sample-chain", 1, 5]);

  r = await call(model, r.events, { kind: "answer", symptomId: "sample-chain", outcome: "pass" });
  // The other candidate has fewer answers, so it is asked next.
  assert.equal(r.screen.current?.symptomId, "sample-short");
  assert.deepEqual(r.screen.items.slice(-2), [
    { by: "bot", kind: "asked", symptomTitle: "SAMPLE שרשרת", number: 1, total: 5, check: "SAMPLE בדיקה s1" },
    { by: "tech", kind: "answer", outcome: "pass", said: undefined },
  ]);
});

test("progress is reported at real stages: before and after the model call", async () => {
  const seen: Progress[] = [];
  await call(new FakeModel([identifies(["sample-chain"])]), [], { kind: "describe", images: [image] }, (p) => seen.push(p));
  assert.deepEqual(seen, ["looking", "matching", "choosing"]);
  const text: Progress[] = [];
  await call(new FakeModel([identifies(["sample-chain"])]), [], { kind: "describe", text: "x" }, (p) => text.push(p));
  assert.deepEqual(text, ["reading", "matching", "choosing"]);
});

test("buttons answer without calling the model or reporting progress", async () => {
  const model = new FakeModel([identifies(["sample-short"])]);
  const r0 = await call(model, [], { kind: "describe", text: "x" });
  const seen: Progress[] = [];
  const r = await call(model, r0.events, { kind: "answer", symptomId: "sample-short", outcome: "pass" }, (p) => seen.push(p));
  assert.equal(model.requests.length, 1);
  assert.deepEqual(seen, []);
  assert.equal(r.screen.mode, "done");
  assert.deepEqual(r.screen.items.slice(-2), [
    { by: "bot", kind: "track_resolved", symptomTitle: "SAMPLE קצר", resolution: "SAMPLE פתרון קצר" },
    { by: "bot", kind: "done", resolved: 1, total: 1 },
  ]);
});

test("a hazard step: stop card, no question until 'understood', then the other candidate continues", async () => {
  const model = new FakeModel([identifies(["sample-hazard-second", "sample-short"])]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  r = await call(model, r.events, { kind: "answer", symptomId: "sample-hazard-second", outcome: "pass" });
  assert.equal(r.screen.mode, "stop");
  assert.deepEqual(r.screen.pendingStop, { symptomId: "sample-hazard-second", title: "SAMPLE מסוכן בצעד שני" });
  assert.equal(r.screen.current, undefined);
  assert.equal(r.screen.items.at(-1)?.kind, "track_stopped");
  assert.ok(!JSON.stringify(r.screen).includes("אסור להציג"));

  r = await call(model, r.events, { kind: "acknowledge", symptomId: "sample-hazard-second" });
  assert.equal(r.screen.mode, "question");
  assert.equal(r.screen.current?.symptomId, "sample-short");
  assert.deepEqual(r.screen.items.slice(-2), [
    { by: "tech", kind: "acknowledged" },
    { by: "bot", kind: "continue", symptomTitle: "SAMPLE קצר" },
  ]);
});

test("a hazard first step shows in the tree without its text", async () => {
  const r = await call(new FakeModel([identifies(["sample-chain", "sample-hazard-first"])]), [], { kind: "describe", text: "x" });
  assert.equal(r.screen.mode, "stop");
  const node = r.screen.trees.find((t) => t.symptomId === "sample-hazard-first")!.nodes[0];
  assert.deepEqual([node.hazard, node.check, node.state], [true, undefined, "stopped"]);
  assert.ok(!JSON.stringify(r.screen).includes("אסור להציג"));
});

test("free text answers the question on screen through interpret, keeping the technician's words", async () => {
  const model = new FakeModel([identifies(["sample-chain", "sample-short"]), interprets("fail")]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  r = await call(model, r.events, { kind: "text", text: "SAMPLE לא עובד" });
  assert.deepEqual(r.screen.items.find((i) => i.kind === "answer"), { by: "tech", kind: "answer", outcome: "fail", said: "SAMPLE לא עובד" });
  assert.equal(r.screen.candidates.find((c) => c.symptomId === "sample-chain")?.status, "resolved");
});

test("danger in free text stops everything with the danger card", async () => {
  const model = new FakeModel([identifies(["sample-chain", "sample-short"]), interprets("danger")]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  r = await call(model, r.events, { kind: "text", text: "SAMPLE עשן" });
  assert.equal(r.screen.mode, "ended");
  assert.equal(r.screen.danger, true);
  assert.deepEqual(r.screen.items.at(-1), { by: "bot", kind: "stopped", reason: "danger", symptomTitle: "SAMPLE שרשרת" });
  assert.equal(r.screen.candidates.find((c) => c.symptomId === "sample-short")?.status, "halted");
});

test("missing information: options start with the model's near misses, then a pick starts the check", async () => {
  const model = new FakeModel([identifies(["sample-short"], "low")]);
  let r = await call(model, [], { kind: "describe", images: [image], media: "photo" });
  assert.equal(r.screen.mode, "identify");
  const more = r.screen.items.at(-1);
  assert.equal(more?.kind, "need_more");
  assert.deepEqual(more?.kind === "need_more" && more.options.map((o) => o.symptomId), ["sample-short", "sample-chain", "sample-hazard-first", "sample-hazard-second"]);

  r = await call(model, r.events, { kind: "pick", symptomId: "sample-short" });
  assert.equal(model.requests.length, 1);
  assert.equal(r.screen.mode, "question");
  assert.deepEqual(r.screen.items.at(-2), { by: "tech", kind: "picked", symptomTitle: "SAMPLE קצר" });
});

test("picking a symptom that is not in the KB does not open anything", async () => {
  const r = await call(new FakeModel(["{}"]), [], { kind: "pick", symptomId: "not-in-kb" });
  assert.equal(r.screen.mode, "identify");
});

test("two failed identifications end honestly as 'not in my KB'", async () => {
  const model = new FakeModel([identifies(["unknown"], "low")]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  r = await call(model, r.events, { kind: "describe", text: "y" });
  assert.equal(r.screen.mode, "ended");
  assert.deepEqual(r.screen.items.at(-1), { by: "bot", kind: "stopped", reason: "unidentified" });
});

test("photos and video frames go to identify; marks come back as a bot message with KB labels", async () => {
  const marks = [
    { frame: 1, symptom_id: "sample-short", cue: 1, box: { x: 100, y: 200, w: 300, h: 150 } },
    { frame: 7, symptom_id: "sample-short", cue: 0, box: { x: 100, y: 200, w: 300, h: 150 } }, // no such frame
  ];
  const model = new FakeModel([identifies(["sample-short"], "high", marks)]);
  const r = await call(model, [], { kind: "describe", images: [image, image, image], media: "video" });
  assert.deepEqual(model.requests[0].content.map((c) => c.type), ["image", "image", "image", "text"]);
  assert.deepEqual(r.screen.items.slice(0, 2), [
    { by: "tech", kind: "media", media: "video", frames: 3, eventIndex: 0, said: undefined },
    { by: "bot", kind: "marked", eventIndex: 0, marks: [{ frame: 1, box: { x: 100, y: 200, w: 300, h: 150 }, label: "SAMPLE רמז ב", symptomTitle: "SAMPLE קצר" }] },
  ]);
});

test("model reason and note never reach the screen", async () => {
  const model = new FakeModel([identifies(["sample-chain"]), interprets("pass")]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  r = await call(model, r.events, { kind: "text", text: "y" });
  const json = JSON.stringify(r.screen);
  assert.ok(!json.includes(REASON) && !json.includes(NOTE));
});

test("a forged event log still cannot open a hazard step", async () => {
  const forged: Event[] = [
    { type: "IDENTIFY_RESULT", result: { candidates: [{ symptom_id: "sample-hazard-second", confidence: "high" }] } },
    { type: "ANSWER", symptomId: "sample-hazard-second", outcome: "pass" },
    { type: "ANSWER", symptomId: "sample-hazard-second", outcome: "pass" },
  ];
  const r = await call(new FakeModel(["{}"]), forged, { kind: "view" });
  assert.equal(r.screen.current, undefined);
  assert.ok(!JSON.stringify(r.screen).includes("אסור להציג"));
});

test("malformed requests are rejected", async () => {
  const model = new FakeModel(["{}"]);
  const bad: unknown[] = [
    null,
    {},
    { events: [], input: { kind: "nope" } },
    { events: [], input: { kind: "escalate" } },
    { events: [], input: { kind: "answer", outcome: "pass" } },
    { events: [], input: { kind: "answer", symptomId: "x", outcome: "danger" } },
    { events: [], input: { kind: "text", text: "" } },
    { events: [], input: { kind: "text", text: "x".repeat(501) } },
    { events: [], input: { kind: "pick" } },
    { events: [], input: { kind: "describe", images: [] } },
    { events: [], input: { kind: "describe", images: Array(7).fill(image) } },
    { events: [{ type: "ANSWER", symptomId: "x", outcome: "maybe" }], input: { kind: "view" } },
    { events: [{ type: "REQUEST_ESCALATION" }], input: { kind: "view" } },
    { events: [{ type: "IDENTIFY_RESULT", result: { candidates: [] }, by: "model" }], input: { kind: "view" } },
    { events: Array(81).fill({ type: "END" }), input: { kind: "view" } },
    { events: [], input: { kind: "view" }, extra: 1 },
  ];
  for (const body of bad) {
    await assert.rejects(handleConversation(kb, model, body), BadRequest, JSON.stringify(body)?.slice(0, 80));
  }
  assert.equal(model.requests.length, 0);
});

test("short answers like 'כן' and 'לא' skip the model; anything longer goes to interpret", async () => {
  assert.deepEqual(["כן", " כן. ", "נכון", "לא", "לא יודע", "כן אבל יש עשן"].map(quickAnswer), ["pass", "pass", "pass", "fail", "unclear", null]);
  const model = new FakeModel([identifies(["sample-chain", "sample-short"]), interprets("danger")]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  r = await call(model, r.events, { kind: "text", text: "כן" });
  assert.equal(model.requests.length, 1);
  assert.deepEqual(r.screen.items.find((i) => i.kind === "answer"), { by: "tech", kind: "answer", outcome: "pass", said: "כן" });
  r = await call(model, r.events, { kind: "text", text: "כן אבל יש עשן" });
  assert.equal(model.requests.length, 2);
  assert.equal(r.screen.mode, "ended");
});

test("while a stop waits, only 'הבנתי' moves on; nothing else answers anything", async () => {
  assert.ok(isAcknowledgement("הבנתי") && isAcknowledgement(" הבנתי, לא נוגע בזה. "));
  assert.ok(!isAcknowledgement("כן") && !isAcknowledgement("הבנתי תראה לי את הצעד"));
  const model = new FakeModel([identifies(["sample-hazard-first", "sample-short"])]);
  let r = await call(model, [], { kind: "describe", text: "x" });
  assert.equal(r.screen.mode, "stop");
  for (const text of ["כן", "תמשיך", "הבנתי תראה לי את הצעד"]) {
    r = await call(model, r.events, { kind: "text", text });
    assert.equal(r.screen.mode, "stop", text);
  }
  r = await call(model, r.events, { kind: "text", text: "הבנתי" });
  assert.equal(r.screen.mode, "question");
  assert.equal(r.screen.current?.symptomId, "sample-short");
  assert.equal(model.requests.length, 1);
});
