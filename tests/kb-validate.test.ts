// Each rule from docs/spec.md gets a broken copy of the sample KB and must produce an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { validateKnowledgeBase } from "../lib/kb-validate";

const KB = path.resolve("knowledge");
// A small fixed KB (one SAMPLE symptom with every construct) that the rule tests break on purpose.
const FIXTURE = path.resolve("tests/fixtures/kb-sample");
const SAMPLE = "symptoms/sample-placeholder.yaml";

// Copies the fixture plus the real schemas to a temp dir, lets `mutate` edit the sample symptom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests mutate raw YAML freely
function resultAfter(mutate: (symptom: any, dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.cpSync(path.join(KB, "schema"), path.join(dir, "schema"), { recursive: true });
  const file = path.join(dir, SAMPLE);
  const symptom = YAML.parse(fs.readFileSync(file, "utf8"));
  mutate(symptom, dir);
  fs.writeFileSync(file, YAML.stringify(symptom));
  try {
    return validateKnowledgeBase(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const errorsAfter = (mutate: Parameters<typeof resultAfter>[0]) => resultAfter(mutate).errors;

function assertError(errors: string[], pattern: RegExp) {
  assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern}, got:\n${errors.join("\n")}`);
}

test("the committed knowledge base is valid", () => {
  assert.deepEqual(validateKnowledgeBase(KB).errors, []);
});

test("the rule-test fixture is valid before it is broken", () => {
  assert.deepEqual(errorsAfter(() => {}), []);
});

test("a spec-example source must be marked sample", () => {
  const errors = errorsAfter((_s, dir) => {
    const file = path.join(dir, "sources.yaml");
    fs.appendFileSync(file, '  - { id: spec-x, type: spec, title: x, date: "2026-10-28" }\n');
  });
  assertError(errors, /type spec, so it must be sample: true/);
});

test("step without source fails the schema", () => {
  assertError(errorsAfter((s) => delete s.steps[0].source), /schema: \/steps\/0 .*source/);
});

test("manual source without page fails the schema", () => {
  assertError(errorsAfter((s) => delete s.steps[0].source.page), /schema: .*page/);
});

test("source.ref missing from sources.yaml", () => {
  assertError(errorsAfter((s) => (s.steps[0].source.ref = "no-such-source")), /not in sources\.yaml/);
});

test("source.type disagreeing with sources.yaml", () => {
  assertError(errorsAfter((s) => (s.steps[3].source = { type: "photo", ref: "sample-mechanic" })), /sources\.yaml says/);
});

test("tip source must be a mechanic", () => {
  assertError(errorsAfter((s) => (s.steps[1].tip.source = { type: "manual", ref: "sample-manual", page: 1 })), /schema: .*tip/);
});

test("transition to a missing step", () => {
  assertError(errorsAfter((s) => (s.steps[0].on_pass = "s99")), /"s99" does not exist/);
});

test("outcome that is neither step, resolve nor escalate", () => {
  assertError(errorsAfter((s) => (s.steps[0].on_fail = { retry: "x" })), /schema: .*on_fail/);
});

test("orphaned step", () => {
  assertError(
    errorsAfter((s) => s.steps.push({ ...s.steps[3], id: "s5" })),
    /step s5 is orphaned/,
  );
});

test("loop between steps", () => {
  assertError(errorsAfter((s) => (s.steps[3].on_fail = "s2")), /loop .*s2 -> s4 -> s2/);
});

test("step pointing to itself", () => {
  assertError(errorsAfter((s) => (s.steps[3].on_fail = "s4")), /points to itself/);
});

test("hazard step must escalate on both outcomes", () => {
  assertError(errorsAfter((s) => (s.steps[2].on_pass = { resolve: "x" })), /hazard: true/);
});

test("empty visual_cues fails the schema", () => {
  assertError(errorsAfter((s) => (s.visual_cues = [])), /schema: \/visual_cues/);
});

test("duplicate step ids", () => {
  assertError(errorsAfter((s) => (s.steps[3].id = "s3")), /duplicate step id/);
});

test("id must match file name", () => {
  assertError(errorsAfter((s) => (s.id = "other-id")), /must match file name/);
});

test("non-sample symptom may not use SAMPLE sources", () => {
  assertError(errorsAfter((s) => delete s.sample), /uses SAMPLE source/);
});

test("real symptoms need a verified device", () => {
  assertError(errorsAfter((s) => delete s.sample), /needs device\.yaml verified: true/);
  const verified = errorsAfter((s, dir) => {
    delete s.sample;
    const file = path.join(dir, "device.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^verified: false$/m, "verified: true"));
  });
  assert.ok(!verified.some((e) => /needs device/.test(e)));
});

test("tip pointing to a missing step", () => {
  const errors = errorsAfter((_s, dir) => {
    fs.writeFileSync(
      path.join(dir, "tips", "bad.yaml"),
      YAML.stringify({
        id: "bad", symptom_id: "sample-placeholder", step_id: "s42", author: "x",
        recorded_at: "2026-10-28", text: "x", status: "pending",
      }),
    );
  });
  assertError(errors, /step_id "s42" does not exist/);
});

test("approved tip must name a step", () => {
  const errors = errorsAfter((_s, dir) => {
    fs.writeFileSync(
      path.join(dir, "tips", "bad.yaml"),
      YAML.stringify({
        id: "bad", symptom_id: "sample-placeholder", author: "x",
        recorded_at: "2026-10-28", text: "x", status: "approved",
      }),
    );
  });
  assertError(errors, /tips\/bad\.yaml: schema/);
});

test("non-hazard step that mentions a hazard topic gets a review warning", () => {
  const { errors, warnings } = resultAfter((s) => (s.steps[0].check = "SAMPLE בדיקה ליד צינור דלק"));
  assert.deepEqual(errors, []);
  assertError(warnings, /step s1 mentions a hazard topic/);
});
