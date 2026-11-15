// skill-eval: runs the fixed fixtures through identify and interpret and scores them against
// the acceptance thresholds in docs/spec.md ("קבלה").
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { KnowledgeBase } from "../kb";
import { symptomCatalog } from "../kb";
import type { ModelClient, SkillContent } from "../llm";
import type { IdentifyResult } from "../safety";
import { identify } from "./identify";
import { interpret } from "./interpret";

export const FIXTURES_DIR = path.resolve("tests/fixtures");

export type CaseResult = { name: string; expected: string; got: string; correct: boolean; ms: number; ok: boolean };

export type SetReport = {
  set: string;
  status: "pass" | "fail" | "pending";
  correct: number;
  total: number;
  required: { minTotal: number; minRatio: number };
  maxMs?: number;
  latencyLimitMs?: number;
  cases: CaseResult[];
};

const ACCURACY = 0.9;
export const PHOTO_LATENCY_LIMIT_MS = 8000;

function report(set: string, cases: CaseResult[], minTotal: number, extra: Partial<SetReport> = {}): SetReport {
  const correct = cases.filter((c) => c.correct).length;
  const latencyOk = extra.latencyLimitMs === undefined || (extra.maxMs ?? 0) <= extra.latencyLimitMs;
  const status =
    cases.length < minTotal ? "pending" : correct / cases.length >= ACCURACY && latencyOk ? "pass" : "fail";
  return { set, status, correct, total: cases.length, required: { minTotal, minRatio: ACCURACY }, cases, ...extra };
}

type InterpretFixtures = {
  checks: Record<string, string>;
  cases: { check: string; answer: string; expected: string }[];
};

export function loadInterpretFixtures(dir = FIXTURES_DIR): InterpretFixtures {
  return YAML.parse(fs.readFileSync(path.join(dir, "skills/interpret.yaml"), "utf8"));
}

export async function evalInterpret(client: ModelClient, fixtures = loadInterpretFixtures()): Promise<SetReport> {
  const cases: CaseResult[] = [];
  for (const c of fixtures.cases) {
    const run = await interpret(client, { check: fixtures.checks[c.check], answer: c.answer });
    cases.push({
      name: c.answer,
      expected: c.expected,
      got: run.output.outcome,
      correct: run.output.outcome === c.expected,
      ms: run.ms,
      ok: run.ok,
    });
  }
  return report("interpret", cases, 30);
}

type IdentifyTextFixtures = {
  catalog: ReturnType<typeof symptomCatalog>;
  cases: { description: string; expected?: string; expected_confidence?: string }[];
};

export function loadIdentifyTextFixtures(dir = FIXTURES_DIR): IdentifyTextFixtures {
  return YAML.parse(fs.readFileSync(path.join(dir, "skills/identify-text.yaml"), "utf8"));
}

// Scored on the top candidate. An empty list (fallback) counts as "unknown" with low confidence.
function topCandidate(result: IdentifyResult): { symptom_id: string; confidence: string } {
  return result.candidates[0] ?? { symptom_id: "unknown", confidence: "low" };
}

function identifyCorrect(result: IdentifyResult, expected?: string, expectedConfidence?: string): boolean {
  const got = topCandidate(result);
  return (
    (expected === undefined || got.symptom_id === expected) &&
    (expectedConfidence === undefined || got.confidence === expectedConfidence)
  );
}

const describeGot = (result: IdentifyResult) =>
  result.candidates.length ? result.candidates.map((c) => `${c.symptom_id} (${c.confidence})`).join(", ") : "unknown (low)";

const describeExpected = (expected?: string, conf?: string) =>
  [expected ?? "*", conf ? `(${conf})` : ""].join(" ").trim();

export async function evalIdentifyText(client: ModelClient, fixtures = loadIdentifyTextFixtures()): Promise<SetReport> {
  const cases: CaseResult[] = [];
  for (const c of fixtures.cases) {
    const run = await identify(client, { catalog: fixtures.catalog, description: c.description });
    cases.push({
      name: c.description,
      expected: describeExpected(c.expected, c.expected_confidence),
      got: describeGot(run.output),
      correct: identifyCorrect(run.output, c.expected, c.expected_confidence),
      ms: run.ms,
      ok: run.ok,
    });
  }
  return report("identify-text", cases, 10);
}

type PhotoManifest = { photos: { file: string; expected: string; expected_confidence?: string }[] };

const MEDIA_TYPES: Record<string, Extract<SkillContent, { type: "image" }>["mediaType"]> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function loadPhotoManifest(dir = FIXTURES_DIR): PhotoManifest {
  const doc = YAML.parse(fs.readFileSync(path.join(dir, "photos/manifest.yaml"), "utf8"));
  return { photos: doc?.photos ?? [] };
}

export async function evalIdentifyPhotos(
  client: ModelClient,
  kb: KnowledgeBase,
  manifest = loadPhotoManifest(),
  dir = path.join(FIXTURES_DIR, "photos"),
): Promise<SetReport> {
  const cases: CaseResult[] = [];
  for (const p of manifest.photos) {
    const mediaType = MEDIA_TYPES[path.extname(p.file).toLowerCase()];
    if (!mediaType) throw new Error(`unsupported photo type: ${p.file}`);
    const data = fs.readFileSync(path.join(dir, p.file)).toString("base64");
    const run = await identify(client, { catalog: symptomCatalog(kb), images: [{ type: "image", mediaType, data }], media: "photo" });
    cases.push({
      name: p.file,
      expected: describeExpected(p.expected, p.expected_confidence),
      got: describeGot(run.output),
      correct: identifyCorrect(run.output, p.expected, p.expected_confidence),
      ms: run.ms,
      ok: run.ok,
    });
  }
  const maxMs = Math.max(0, ...cases.map((c) => c.ms));
  return report("identify-photos", cases, 20, { maxMs, latencyLimitMs: PHOTO_LATENCY_LIMIT_MS });
}
