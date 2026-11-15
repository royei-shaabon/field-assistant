// interpret skill: the current step and the technician's free text -> pass/fail/unclear/danger.
// It never sees the tree and never picks the next step.
import type { Step } from "../kb";
import type { ModelClient } from "../llm";
import type { AnswerOutcome } from "../safety";
import { loadSkillFiles, runSkill, type SkillFiles, type SkillRun } from "./run-skill";

export type InterpretResult = { outcome: AnswerOutcome; note: string };

export const INTERPRET_FALLBACK: InterpretResult = { outcome: "unclear", note: "" };

export type InterpretInput = { check: string; how?: string; answer: string };

export function interpretInput(step: Pick<Step, "check" | "how">, answer: string): InterpretInput {
  return { check: step.check, ...(step.how ? { how: step.how } : {}), answer };
}

export function interpret(
  client: ModelClient,
  input: InterpretInput,
  files: SkillFiles = loadSkillFiles("interpret"),
): Promise<SkillRun<InterpretResult>> {
  return runSkill<InterpretResult>({
    client,
    files,
    content: [{ type: "text", text: JSON.stringify(input) }],
    fallback: INTERPRET_FALLBACK,
  });
}
