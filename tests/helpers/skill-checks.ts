// Checks shared by the identify and interpret skill tests.
import assert from "node:assert/strict";
import Ajv from "ajv";
import { loadKnowledgeBase } from "../../lib/kb";
import type { SkillFiles } from "../../lib/skills/run-skill";

// Structured outputs needs additionalProperties: false on every object and rejects
// numeric and string-length constraints.
export function assertApiCompatibleSchema(schema: unknown, at = "#"): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;
  for (const banned of ["minimum", "maximum", "multipleOf", "minLength", "maxLength"]) {
    assert.ok(!(banned in s), `${at} uses unsupported "${banned}"`);
  }
  if (s.type === "object") assert.equal(s.additionalProperties, false, `${at} needs additionalProperties: false`);
  for (const [k, v] of Object.entries(s)) assertApiCompatibleSchema(v, `${at}/${k}`);
}

export function assertExamplesValid(files: SkillFiles): void {
  assert.ok(files.examples.length >= 5 && files.examples.length <= 10, "spec: 5-10 examples");
  const validate = new Ajv().compile(files.schema);
  for (const e of files.examples) assert.ok(validate(e.output), JSON.stringify(e.output));
}

// No professional knowledge in prompts: no text from the KB may appear in prompt.md or examples.
export function assertNoKbText(files: SkillFiles): void {
  const haystack = files.prompt + JSON.stringify(files.examples);
  const kb = loadKnowledgeBase();
  for (const symptom of kb.symptoms.values()) {
    const texts = [symptom.id, symptom.title, ...symptom.visual_cues];
    for (const step of symptom.steps) texts.push(step.check, step.how ?? "", step.tip?.text ?? "");
    for (const t of texts.filter(Boolean)) assert.ok(!haystack.includes(t), `skill text contains KB text: ${t}`);
  }
}
