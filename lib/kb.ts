// Knowledge base types, loading and queries. The KB is read-only at runtime.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { validateKnowledgeBase } from "./kb-validate";

export type SourceType = "manual" | "service_manual" | "mechanic" | "photo" | "spec";

export type SourceRef = { type: SourceType; ref: string; page?: number };

export type Outcome = string | { resolve: string } | { escalate: string };

export type Step = {
  id: string;
  check: string;
  how?: string;
  source: SourceRef;
  hazard: boolean;
  tip?: { author: string; text: string; source: SourceRef };
  conflict?: boolean;
  on_pass: Outcome;
  on_fail: Outcome;
};

export type Symptom = {
  id: string;
  title: string;
  sample?: boolean;
  visual_cues: string[];
  steps: Step[];
  escalate_after_steps: number;
};

export type Source = {
  id: string;
  type: SourceType;
  title: string;
  date: string;
  file?: string;
  notes?: string;
  sample?: boolean;
};

export type Tip = {
  id: string;
  symptom_id: string;
  step_id?: string | null;
  author: string;
  recorded_at: string;
  transcript?: string;
  text: string;
  status: "pending" | "approved" | "rejected";
  sample?: boolean;
};

export type KnowledgeBase = {
  sources: Map<string, Source>;
  symptoms: Map<string, Symptom>;
};

function readYaml<T>(file: string): T {
  return YAML.parse(fs.readFileSync(file, "utf8")) as T;
}

// Loads the KB and refuses to return anything that does not pass kb:validate.
export function loadKnowledgeBase(kbDir: string = path.resolve("knowledge")): KnowledgeBase {
  const { errors } = validateKnowledgeBase(kbDir);
  if (errors.length) throw new Error(`knowledge base is invalid:\n${errors.join("\n")}`);

  const { sources } = readYaml<{ sources: Source[] }>(path.join(kbDir, "sources.yaml"));
  const symptomDir = path.join(kbDir, "symptoms");
  const symptoms = fs
    .readdirSync(symptomDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readYaml<Symptom>(path.join(symptomDir, f)));

  return {
    sources: new Map(sources.map((s) => [s.id, s])),
    symptoms: new Map(symptoms.map((s) => [s.id, s])),
  };
}

export function getSymptom(kb: KnowledgeBase, id: string): Symptom | undefined {
  return kb.symptoms.get(id);
}

export function getStep(symptom: Symptom, stepId: string): Step | undefined {
  return symptom.steps.find((s) => s.id === stepId);
}

// What the identify skill receives: ids and visual cues only, no steps.
export function symptomCatalog(kb: KnowledgeBase): { id: string; title: string; visual_cues: string[] }[] {
  return [...kb.symptoms.values()].map(({ id, title, visual_cues }) => ({ id, title, visual_cues }));
}
