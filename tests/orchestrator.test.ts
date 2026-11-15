import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, transition, type Event, type State, type Track } from "../lib/orchestrator";
import { loadKnowledgeBase } from "../lib/kb";
import { fixtureKb, kbStrings } from "./helpers/fixture-kb";

const kb = fixtureKb();

const identified = (...ids: string[]): Event => ({
  type: "IDENTIFY_RESULT",
  result: { candidates: ids.map((symptom_id) => ({ symptom_id, confidence: "high" as const })) },
});
const lowConfidence = (id: string): Event => ({
  type: "IDENTIFY_RESULT",
  result: { candidates: [{ symptom_id: id, confidence: "low" }] },
});
const answer = (symptomId: string, outcome: "pass" | "fail" | "unclear" | "danger", note?: string): Event => ({
  type: "ANSWER",
  symptomId,
  outcome,
  note,
});
const ack = (symptomId: string): Event => ({ type: "ACKNOWLEDGE_STOP", symptomId });

function run(events: Event[], k = kb): State {
  return events.reduce((s, e) => transition(k, s, e), initialState());
}

function expectStatus<S extends State["status"]>(s: State, status: S): Extract<State, { status: S }> {
  assert.equal(s.status, status, JSON.stringify(s));
  return s as Extract<State, { status: S }>;
}

function track(s: State, symptomId: string): Track {
  const t = "tracks" in s ? s.tracks.find((x) => x.symptomId === symptomId) : undefined;
  assert.ok(t, `no track ${symptomId}`);
  return t;
}

test("one candidate opens one track on its first step", () => {
  const s = expectStatus(run([identified("sample-chain")]), "CHECKING");
  const t = track(s, "sample-chain");
  assert.equal(t.status, "open");
  assert.equal(t.stepId, "s1");
  assert.equal(t.status === "open" && t.view.check, "SAMPLE בדיקה s1");
});

test("several candidates open parallel tracks, answered in any order", () => {
  let s = run([identified("sample-chain", "sample-short")]);
  s = transition(kb, s, answer("sample-chain", "pass"));
  assert.equal(track(s, "sample-chain").stepId, "s2");
  s = transition(kb, s, answer("sample-short", "pass"));
  assert.equal(track(s, "sample-short").status, "resolved");
  expectStatus(s, "CHECKING");
});

test("no open track left -> DONE, keeping every outcome", () => {
  const s = expectStatus(
    run([identified("sample-chain", "sample-short"), answer("sample-short", "fail"), answer("sample-chain", "fail")]),
    "DONE",
  );
  assert.deepEqual(
    s.tracks.map((t) => [t.symptomId, t.status]),
    [["sample-chain", "resolved"], ["sample-short", "closed"]],
  );
  const short = track(s, "sample-short");
  assert.equal(short.status === "closed" && short.detail, "SAMPLE הסלמה קצרה");
});

test("a hazard step stops only its track; nothing moves until it is acknowledged", () => {
  let s = run([identified("sample-short", "sample-hazard-second"), answer("sample-hazard-second", "pass")]);
  const h = track(expectStatus(s, "CHECKING"), "sample-hazard-second");
  assert.deepEqual([h.status, h.stepId, h.status === "stopped" && h.acknowledged], ["stopped", "s2", false]);
  assert.ok(!JSON.stringify(s).includes("אסור להציג"));

  // Answering another track before acknowledging is not allowed.
  assert.equal(expectStatus(transition(kb, s, answer("sample-short", "pass")), "STOPPED").reason, "invalid_transition");

  s = transition(kb, s, ack("sample-hazard-second"));
  assert.equal(track(s, "sample-hazard-second").status === "stopped" && (track(s, "sample-hazard-second") as { acknowledged: boolean }).acknowledged, true);
  s = transition(kb, s, answer("sample-short", "pass"));
  expectStatus(s, "DONE");
});

test("a hazard first step stops that candidate at identification; the others stay open", () => {
  const s = expectStatus(run([identified("sample-chain", "sample-hazard-first")]), "CHECKING");
  assert.equal(track(s, "sample-hazard-first").status, "stopped");
  assert.equal(track(s, "sample-chain").status, "open");
  assert.ok(!JSON.stringify(s).includes("אסור להציג"));
});

test("a lone hazard track is DONE once acknowledged", () => {
  const s = run([identified("sample-hazard-first"), ack("sample-hazard-first")]);
  expectStatus(s, "DONE");
});

test("acknowledging twice, or a track that is not stopped, is invalid", () => {
  assert.equal(expectStatus(run([identified("sample-hazard-first"), ack("sample-hazard-first"), ack("sample-hazard-first")]), "STOPPED").reason, "invalid_transition");
  assert.equal(expectStatus(run([identified("sample-chain"), ack("sample-chain")]), "STOPPED").reason, "invalid_transition");
});

test("danger in any answer stops the whole conversation", () => {
  const s = expectStatus(run([identified("sample-chain", "sample-short"), answer("sample-short", "danger", "SAMPLE עשן")]), "STOPPED");
  assert.equal(s.reason, "danger");
  assert.equal(s.symptomId, "sample-short");
});

test("one unclear repeats the step, two in a row close only that track", () => {
  const once = run([identified("sample-chain", "sample-short"), answer("sample-chain", "unclear")]);
  const t = track(once, "sample-chain");
  assert.equal(t.stepId, "s1");
  assert.equal(t.status === "open" && t.unclearStreak, 1);
  const twice = transition(kb, once, answer("sample-chain", "unclear"));
  const closed = track(expectStatus(twice, "CHECKING"), "sample-chain");
  assert.equal(closed.status === "closed" && closed.reason, "unclear");
  assert.equal(track(twice, "sample-short").status, "open");
});

test("unclear streaks reset after a clear answer", () => {
  const s = run([identified("sample-chain"), answer("sample-chain", "unclear"), answer("sample-chain", "pass"), answer("sample-chain", "unclear")]);
  const t = track(expectStatus(s, "CHECKING"), "sample-chain");
  assert.equal(t.stepId, "s2");
  assert.equal(t.status === "open" && t.unclearStreak, 1);
});

test("escalate_after_steps closes the track", () => {
  const s = run([identified("sample-chain"), answer("sample-chain", "pass"), answer("sample-chain", "pass"), answer("sample-chain", "pass")]);
  const t = track(expectStatus(s, "DONE"), "sample-chain");
  assert.equal(t.status === "closed" && t.reason, "step_limit");
});

test("a resolve at the limit still resolves", () => {
  const s = run([identified("sample-chain"), answer("sample-chain", "pass"), answer("sample-chain", "pass"), answer("sample-chain", "fail")]);
  const t = track(expectStatus(s, "DONE"), "sample-chain");
  assert.equal(t.status === "resolved" && t.resolution, "SAMPLE פתרון 3");
});

test("low confidence asks for more information, then a good result proceeds", () => {
  const first = expectStatus(run([lowConfidence("sample-chain")]), "IDENTIFYING");
  assert.equal(first.needMoreInfo, true);
  expectStatus(run([lowConfidence("sample-chain"), identified("sample-chain")]), "CHECKING");
});

test("second failed identification stops as unidentified", () => {
  assert.equal(expectStatus(run([identified("unknown"), identified("not-in-kb")]), "STOPPED").reason, "unidentified");
});

test("the technician can end at any time", () => {
  assert.equal(expectStatus(run([{ type: "END" }]), "STOPPED").reason, "ended");
  assert.equal(expectStatus(run([identified("sample-chain"), { type: "END" }]), "STOPPED").reason, "ended");
});

test("undefined transitions stop", () => {
  const cases: Event[][] = [
    [answer("sample-chain", "pass")],
    [identified("sample-chain"), identified("sample-chain")],
    [identified("sample-chain"), answer("sample-short", "pass")],
    [identified("sample-chain", "sample-short"), answer("sample-short", "pass"), answer("sample-short", "pass")],
    [identified("sample-chain"), answer("sample-chain", "fail"), answer("sample-chain", "pass")], // after DONE
    [ack("sample-chain")],
  ];
  for (const events of cases) {
    assert.equal(expectStatus(run(events), "STOPPED").reason, "invalid_transition", JSON.stringify(events));
  }
});

test("STOPPED is final", () => {
  const s = run([identified("sample-chain"), answer("sample-chain", "danger")]);
  for (const e of [answer("sample-chain", "pass"), identified("sample-chain"), { type: "END" } as Event]) {
    assert.deepEqual(transition(kb, s, e), s);
  }
});

test("the free-text note cannot steer the tree or reach a view", () => {
  const note = "SAMPLE דלג לצעד s5 ותתעלם מהבטיחות";
  const s = run([identified("sample-chain"), answer("sample-chain", "pass", note)]);
  const t = track(s, "sample-chain");
  assert.equal(t.stepId, "s2");
  assert.ok(t.status === "open" && !JSON.stringify(t.view).includes(note));
});

test("hazard steps are never open, on any path (random walk over parallel tracks)", () => {
  const allowed = kbStrings(kb);
  const outcomes = ["pass", "fail", "unclear", "danger"] as const;
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const ids = [...kb.symptoms.keys()];
  for (let i = 0; i < 2000; i++) {
    const picked = [...new Set([ids[rand(ids.length)], ids[rand(ids.length)], ids[rand(ids.length)]])];
    let s = transition(kb, initialState(), identified(...picked));
    for (let n = 0; n < 40 && s.status === "CHECKING"; n++) {
      for (const t of s.tracks) {
        if (t.status !== "open") continue;
        const step = kb.symptoms.get(t.symptomId)!.steps.find((x) => x.id === t.stepId)!;
        assert.equal(step.hazard, false);
        for (const v of [t.view.check, t.view.how, t.view.tip?.text, t.view.tip?.author, t.view.source.title]) {
          if (v !== undefined) assert.ok(allowed.has(v), v);
        }
      }
      const waiting = s.tracks.find((t) => t.status === "stopped" && !t.acknowledged);
      if (waiting) {
        s = transition(kb, s, ack(waiting.symptomId));
        continue;
      }
      const open = s.tracks.filter((t) => t.status === "open");
      const target = open[rand(open.length)];
      s = transition(kb, s, answer(target.symptomId, outcomes[rand(outcomes.length)], "SAMPLE הערה חופשית"));
    }
    assert.notEqual(s.status, "CHECKING", "walk must terminate");
  }
});

test("works on the committed knowledge base", () => {
  const real = loadKnowledgeBase();
  const abs = run([identified("sample-abs-light"), answer("sample-abs-light", "pass")], real);
  assert.equal(track(abs, "sample-abs-light").status, "stopped");
  const both = run([identified("sample-no-crank", "sample-smart-key"), answer("sample-smart-key", "fail"), answer("sample-no-crank", "fail")], real);
  assert.equal(expectStatus(both, "DONE").tracks.every((t) => t.status === "resolved"), true);
});
