// Shared runner for product skills (docs/spec.md, "סקילים"): one model call, output validated
// against skills/<name>/schema.json, one retry, then a fixed fallback. Never continues on
// broken output.
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import YAML from "yaml";
import type { ModelClient, SkillContent } from "../llm";

export const SKILLS_DIR = path.resolve("skills");
export const MAX_ATTEMPTS = 2;

export type SkillFiles = {
  prompt: string;
  schema: Record<string, unknown>;
  examples: { input: unknown; output: unknown }[];
};

export function loadSkillFiles(name: string, dir: string = SKILLS_DIR): SkillFiles {
  // Files are listed in next.config.ts outputFileTracingIncludes, so tracing can skip this.
  const base = path.join(/*turbopackIgnore: true*/ dir, name);
  return {
    prompt: fs.readFileSync(path.join(base, "prompt.md"), "utf8"),
    schema: JSON.parse(fs.readFileSync(path.join(base, "schema.json"), "utf8")),
    examples: YAML.parse(fs.readFileSync(path.join(base, "examples.yaml"), "utf8")).examples,
  };
}

// System prompt = prompt.md followed by the examples as JSON input/output pairs.
export function systemPrompt(files: SkillFiles): string {
  const examples = files.examples
    .map((e, i) => `### Example ${i + 1}\nInput:\n${JSON.stringify(e.input)}\nOutput:\n${JSON.stringify(e.output)}`)
    .join("\n\n");
  return `${files.prompt.trim()}\n\n## Examples\n\n${examples}\n`;
}

export type SkillRun<T> = { output: T; ok: boolean; attempts: number; errors: string[]; ms: number };

export async function runSkill<T>(opts: {
  client: ModelClient;
  files: SkillFiles;
  content: SkillContent[];
  // Schema sent to the API; may narrow skills/<name>/schema.json (e.g. an enum of ids).
  requestSchema?: Record<string, unknown>;
  // Checks the schema cannot express. Returns an error message or null.
  check?: (output: T) => string | null;
  fallback: T;
}): Promise<SkillRun<T>> {
  const started = Date.now();
  const validate = new Ajv({ allErrors: true }).compile(opts.files.schema);
  const errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { text, stopReason } = await opts.client.complete({
        system: systemPrompt(opts.files),
        content: opts.content,
        schema: opts.requestSchema ?? opts.files.schema,
      });
      if (text === null) throw new Error(`no output (stop_reason: ${stopReason})`);
      const parsed: unknown = JSON.parse(text);
      if (!validate(parsed)) throw new Error(`schema: ${new Ajv().errorsText(validate.errors)}`);
      const problem = opts.check?.(parsed as T);
      if (problem) throw new Error(problem);
      return { output: parsed as T, ok: true, attempts: attempt, errors, ms: Date.now() - started };
    } catch (e) {
      errors.push(`attempt ${attempt}: ${(e as Error).message}`);
    }
  }
  return { output: opts.fallback, ok: false, attempts: MAX_ATTEMPTS, errors, ms: Date.now() - started };
}
