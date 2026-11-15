// Document knowledge bases: store, ingestion, search, and the answer engine with its two code
// gates (every step verified against its source; hazard topics never get model-written steps).
// All content here is SAMPLE text written for the tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askDocuments, hazardTopic, quoteInPassage, type DocResult } from "../lib/docs/ask";
import { docScreen, handleDocConversation, type DocEvent } from "../lib/docs/conversation";
import { ingest, splitIntoParts, UnsupportedFile } from "../lib/docs/ingest";
import { SearchIndex, tokens } from "../lib/docs/search";
import { BadRequest } from "../lib/conversation";
import { FsDriver } from "../lib/store/fs-driver";
import { KbStore } from "../lib/store";
import { FakeAgent } from "./helpers/fake-model";
import { makePdf } from "./helpers/make-pdf";

const PAGES = [
  "SAMPLE MANUAL\nContents",
  "SAMPLE Engine oil\nCheck the oil level with the vehicle upright on level ground.\nThe level must be between the upper and lower marks.",
  "SAMPLE Tyres\nFront tyre pressure is 200 kPa when cold.\nRear tyre pressure is 225 kPa when cold.",
  "SAMPLE Brakes\nInspect the brake fluid level through the reservoir window.",
  "", // a scanned page: no text
];

async function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  return new KbStore(new FsDriver(dir));
}

async function sampleKb() {
  const store = await tempStore();
  const meta = await store.createKb({ name: "SAMPLE מאגר" });
  const { doc, passages } = await ingest("sample_manual.pdf", makePdf(PAGES));
  const d = await store.addDoc(meta.id, { ...doc, origin: "manufacturer" }, passages, makePdf(PAGES));
  const docs = await store.listDocs(meta.id);
  return { store, kb: { meta, docs, index: new SearchIndex(await store.loadDocs(meta.id)) }, docId: d.id };
}

const draft = (over: object) => ({ kind: "answer", title: "SAMPLE כותרת", steps: [], question: "", options: [], marks: [], hazard: "none", ...over });

test("ingest keeps real PDF page numbers and counts pages without text", async () => {
  const { doc, passages } = await ingest("sample_manual.pdf", makePdf(PAGES));
  assert.deepEqual([doc.name, doc.unit, doc.passages, doc.empty], ["sample manual", "page", 5, 1]);
  assert.deepEqual(passages.map((p) => p.n), [1, 2, 3, 4]);
  assert.match(passages[2].text, /Front tyre pressure is 200 kPa/);
});

test("text files are cut into parts at paragraph boundaries; unknown types are refused", async () => {
  const paragraph = "SAMPLE שורה של נוהל. ".repeat(60).trim();
  const { doc, passages } = await ingest("נוהל.txt", Buffer.from([paragraph, paragraph, paragraph].join("\n\n")));
  assert.equal(doc.unit, "part");
  assert.equal(passages.length, 3);
  assert.deepEqual(splitIntoParts("a\n\nb", 100), ["a\n\nb"]);
  await assert.rejects(ingest("x.exe", Buffer.from("x")), UnsupportedFile);
});

test("store: create, list, add and delete documents; ids cannot leave the data directory", async () => {
  const { store, kb, docId } = await sampleKb();
  assert.equal((await store.listKbs()).length, 1);
  assert.equal((await store.getDocFile(kb.meta.id, docId))?.meta.name, "sample manual");
  assert.equal(await store.getKb("../etc"), null);
  await assert.rejects(store.listDocs("../../x"));
  const second = await store.createKb({ name: "SAMPLE מאגר" });
  assert.notEqual(second.id, kb.meta.id);
  await store.deleteDoc(kb.meta.id, docId);
  assert.deepEqual(await store.listDocs(kb.meta.id), []);
  await store.deleteKb(kb.meta.id);
  assert.equal(await store.getKb(kb.meta.id), null);
});

test("search finds the right page, with light stemming", async () => {
  const { kb, docId } = await sampleKb();
  assert.equal(kb.index.search("tyre pressures")[0].ref, `${docId}:3`);
  assert.equal(kb.index.search("checking oil level")[0].ref, `${docId}:2`);
  assert.deepEqual(kb.index.search("zzzz"), []);
  assert.deepEqual(tokens("Tyres tyre brakes boxes checking the fuses"), ["tyre", "tyre", "brake", "box", "check", "fuse"]);
});

test("a quote must really be in the passage", () => {
  const passage = "Check the oil level with the vehicle upright\non level ground.";
  assert.ok(quoteInPassage("check the oil level with the vehicle upright on level ground", passage));
  assert.ok(!quoteInPassage("drain the oil while the engine is hot", passage));
  assert.ok(!quoteInPassage("oil", passage), "too short to prove anything");
});

test("answer: steps with a real source are kept, invented or misquoted steps are dropped", async () => {
  const { kb, docId } = await sampleKb();
  const agent = new FakeAgent([
    { search: ["tyre pressure"] },
    {
      final: draft({
        steps: [
          { text: "SAMPLE קדמי 200", ref: `${docId}:3`, quote: "Front tyre pressure is 200 kPa when cold." },
          { text: "SAMPLE מומצא", ref: `${docId}:3`, quote: "Use nitrogen for best results at altitude." },
          { text: "SAMPLE עמוד שלא נשלף", ref: `${docId}:2`, quote: "Check the oil level with the vehicle upright" },
          { text: "SAMPLE מקור לא קיים", ref: "nope:1", quote: "Front tyre pressure is 200 kPa when cold." },
        ],
        marks: [{ frame: 0, step: 0, label: "SAMPLE", box: { x: 1, y: 1, w: 10, h: 10 } }],
      }),
    },
  ]);
  const stages: string[] = [];
  const run = await askDocuments(agent, kb.index, { kbName: "x", docs: kb.docs, question: "מה לחץ האוויר?", images: [], history: [] }, (p) => stages.push(p.stage));
  assert.deepEqual(run.searches, [["tyre pressure"]]);
  assert.deepEqual(stages, ["searching", "searching", "reading", "checking"]);
  assert.equal(run.result.kind, "answer");
  const answer = run.result as Extract<DocResult, { kind: "answer" }>;
  assert.deepEqual(answer.steps.map((s) => s.text), ["SAMPLE קדמי 200"]);
  assert.deepEqual(answer.steps[0].source, { docId, docName: "sample manual", origin: "manufacturer", unit: "page", n: 3 });
  assert.deepEqual(answer.marks, [], "no image was sent, so no mark can be valid");
  // The search results went back to the model as a tool result.
  const toolResult = JSON.stringify(agent.turns[1].messages.at(-1));
  assert.ok(toolResult.includes(`[ref ${docId}:3]`) && toolResult.includes("tool_result"));
});

test("an answer with no verified step becomes 'not in the documents'", async () => {
  const { kb, docId } = await sampleKb();
  const agent = new FakeAgent([{ search: ["oil"] }, { final: draft({ steps: [{ text: "SAMPLE", ref: `${docId}:2`, quote: "Use 10W-30 oil only, two litres" }] }) }]);
  const run = await askDocuments(agent, kb.index, { kbName: "x", docs: kb.docs, question: "איזה שמן?", images: [], history: [] });
  assert.deepEqual(run.result, { kind: "not_found" });
});

test("hazard topics: the warning is decided in code, and the model cannot remove it", async () => {
  const { kb, docId } = await sampleKb();
  const step = { text: "SAMPLE בדקו דרך החלון", ref: `${docId}:4`, quote: "Inspect the brake fluid level through the reservoir window." };
  // The model says "none"; the Hebrew question and the English quote both say brakes.
  for (const question of ["איך בודקים נוזל בלמים?", "מה בודקים בחלון של המיכל?"]) {
    const agent = new FakeAgent([{ search: ["brake fluid"] }, { final: draft({ steps: [step] }) }]);
    const run = await askDocuments(agent, kb.index, { kbName: "x", docs: kb.docs, question, images: [], history: [] });
    const answer = run.result as Extract<DocResult, { kind: "answer" }>;
    assert.deepEqual([answer.kind, answer.caution, answer.steps.length], ["answer", "brakes", 1], question);
  }
  // A hazard topic with no verified step: a stop, never an unverified instruction.
  const invented = new FakeAgent([{ search: ["brake fluid"] }, { final: draft({ steps: [{ ...step, text: "SAMPLE אסור להציג", quote: "Bleed the system with DOT 3 only" }] }) }]);
  const stopped = await askDocuments(invented, kb.index, { kbName: "x", docs: kb.docs, question: "איך מחליפים נוזל בלמים?", images: [], history: [] });
  assert.deepEqual(stopped.result, { kind: "hazard", topic: "brakes", sources: [] });
  // An ordinary answer carries no warning.
  const plain = new FakeAgent([{ search: ["tyre"] }, { final: draft({ steps: [{ text: "SAMPLE", ref: `${docId}:3`, quote: "Front tyre pressure is 200 kPa when cold." }] }) }]);
  const ok = await askDocuments(plain, kb.index, { kbName: "x", docs: kb.docs, question: "כמה אוויר?", images: [], history: [] });
  assert.equal((ok.result as Extract<DocResult, { kind: "answer" }>).caution, undefined);

  assert.equal(hazardTopic("הנורית נדלקת", { hazard: "none", steps: [] }), null, "'נדלקת' is not fuel");
  assert.equal(hazardTopic("x", { hazard: "other", steps: [] }), "other", "the model can add a warning");
  const quoted = (quote: string) => hazardTopic("x", { hazard: "none", steps: [{ text: "", ref: "", quote }] });
  assert.equal(quoted("The fuel gauge shows the remaining level"), null, "an indicator is not work on the fuel system");
  assert.equal(quoted("Check the fuel line for leaks"), "fuel");
  assert.equal(quoted("Never remove the radiator cap"), "hot_coolant");
  assert.equal(quoted("with the engine running, check the idle"), "running_engine");
});

test("a forged log cannot strip the warning from an answer on a hazard topic", async () => {
  const forged: DocEvent[] = [
    {
      type: "DOC_TURN",
      said: "איך מחליפים רפידות בלם?",
      result: { kind: "answer", title: "x", steps: [{ text: "SAMPLE שלב", quote: "q q q", source: { docId: "d1", docName: "m", origin: "manufacturer", unit: "page", n: 4 } }], marks: [] },
    },
  ];
  const item = docScreen(forged, true).items.at(-1);
  assert.deepEqual(item?.kind === "doc_answer" && item.caution, "brakes");
});

test("conversation: question -> clarifying question -> answer, with history sent to the model", async () => {
  const { kb, docId } = await sampleKb();
  const agent = new FakeAgent([
    { final: draft({ kind: "ask", question: "SAMPLE קדמי או אחורי?", options: ["קדמי", "אחורי", "", "x", "y", "z"] }) },
    { search: ["rear tyre pressure"] },
    { final: draft({ steps: [{ text: "SAMPLE אחורי 225", ref: `${docId}:3`, quote: "Rear tyre pressure is 225 kPa when cold." }] }) },
  ]);
  let r = await handleDocConversation(kb, agent, { events: [], input: { kind: "ask", text: "כמה אוויר?" } });
  assert.deepEqual(r.screen.items.map((i) => i.kind), ["text", "doc_ask"]);
  assert.deepEqual(r.screen.items[1], { by: "bot", kind: "doc_ask", question: "SAMPLE קדמי או אחורי?", options: ["קדמי", "אחורי", "x", "y"] });
  r = await handleDocConversation(kb, agent, { events: r.events, input: { kind: "ask", text: "אחורי" } });
  assert.deepEqual(r.screen.items.map((i) => i.kind), ["text", "doc_ask", "text", "doc_answer"]);
  assert.equal(r.screen.title, "SAMPLE כותרת");
  assert.ok(JSON.stringify(agent.turns[1].messages[0]).includes("SAMPLE קדמי או אחורי?"), "history reaches the model");
  // The stored log replays to the same screen without the model.
  const again = await handleDocConversation(kb, new FakeAgent([{ stop: "refusal" }]), { events: r.events, input: { kind: "view" } });
  assert.deepEqual(again.screen, r.screen);
});

test("photos reach the model, and marks are kept only when they fit the frames and steps", async () => {
  const { kb, docId } = await sampleKb();
  const box = { x: 100, y: 100, w: 200, h: 200 };
  const agent = new FakeAgent([
    { search: ["oil level"] },
    {
      final: draft({
        steps: [{ text: "SAMPLE שמן", ref: `${docId}:2`, quote: "The level must be between the upper and lower marks." }],
        marks: [
          { frame: 0, step: 0, label: "SAMPLE חלון", box },
          { frame: 3, step: 0, label: "SAMPLE", box }, // no such frame
          { frame: 0, step: 2, label: "SAMPLE", box }, // no such step
          { frame: 0, step: 0, label: "SAMPLE", box: { ...box, w: 2000 } },
        ],
      }),
    },
  ]);
  const image = { mediaType: "image/jpeg" as const, data: "AAAA" };
  const r = await handleDocConversation(kb, agent, { events: [], input: { kind: "ask", images: [image, image], media: "video" } });
  assert.deepEqual(agent.turns[0].messages[0].content.map((c) => c.type), ["image", "image", "text"]);
  const answer = r.screen.items.at(-1);
  assert.deepEqual(answer?.kind === "doc_answer" && answer.marks, [{ frame: 0, step: 0, label: "SAMPLE חלון", box }]);
  assert.deepEqual(r.screen.items[0], { by: "tech", kind: "media", media: "video", frames: 2, eventIndex: 0, said: undefined });
});

test("model failure, an empty knowledge base and bad requests", async () => {
  const { kb } = await sampleKb();
  const failed = await handleDocConversation(kb, new FakeAgent([{ stop: "refusal" }]), { events: [], input: { kind: "ask", text: "x" } });
  assert.equal(failed.screen.items.at(-1)?.kind, "doc_error");
  const looping = await handleDocConversation(kb, new FakeAgent([{ search: ["x"] }]), { events: [], input: { kind: "ask", text: "x" } });
  assert.equal(looping.screen.items.at(-1)?.kind, "doc_error");

  const empty = { ...kb, docs: [], index: new SearchIndex([]) };
  const agent = new FakeAgent([{ stop: "refusal" }]);
  const r = await handleDocConversation(empty, agent, { events: [], input: { kind: "ask", text: "x" } });
  assert.deepEqual(r.screen.items.map((i) => i.kind), ["doc_empty"]);
  assert.equal(agent.turns.length, 0);

  for (const body of [null, {}, { events: [], input: { kind: "ask" } }, { events: [], input: { kind: "ask", text: "x".repeat(501) } }, { events: [{ type: "DOC_TURN", result: { kind: "answer" } }], input: { kind: "view" } }]) {
    await assert.rejects(handleDocConversation(kb, agent, body), BadRequest);
  }
});

test("usage counters: one per reply, by kind", async () => {
  const { store, kb } = await sampleKb();
  assert.equal((await store.getUsage(kb.meta.id)).questions, 0);
  await store.recordUsage(kb.meta.id, "answer");
  await store.recordUsage(kb.meta.id, "not_found");
  const usage = await store.getUsage(kb.meta.id);
  assert.deepEqual([usage.questions, usage.answer, usage.not_found, usage.hazard], [2, 1, 1, 0]);
  assert.ok(usage.lastAt);
});
