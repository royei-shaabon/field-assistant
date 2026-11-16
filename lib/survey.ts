// The short survey after a call: three optional questions, each answered with one tap.
// The answers are fixed keys (no free text), so they can be counted.
export const SURVEY = {
  solved: ["yes", "partly", "no"],
  improve: ["nothing", "accuracy", "speed", "understanding", "marks"],
  again: ["yes", "no"],
} as const;

export type SurveyAnswers = { solved?: (typeof SURVEY.solved)[number]; improve?: (typeof SURVEY.improve)[number]; again?: (typeof SURVEY.again)[number] };

const pick = <T extends string>(options: readonly T[], value: unknown): T | undefined => options.find((o) => o === value);

// Only known answers pass; anything else is dropped. Null when nothing was answered.
export function cleanSurvey(raw: unknown): SurveyAnswers | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: SurveyAnswers = { solved: pick(SURVEY.solved, r.solved), improve: pick(SURVEY.improve, r.improve), again: pick(SURVEY.again, r.again) };
  return out.solved || out.improve || out.again ? out : null;
}
