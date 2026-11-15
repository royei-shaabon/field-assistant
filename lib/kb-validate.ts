// Validates the knowledge base in knowledge/. Rules come from docs/spec.md ("מבנה מאגר הידע").
// Pure function: reads files, returns errors. The CLI wrapper is scripts/kb-validate.ts.
import fs from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import YAML from "yaml";
import type { Outcome, Source, SourceRef, Symptom, Tip } from "./kb";
import { mentionsHazardTopic } from "./safety";

export type ValidationResult = {
  errors: string[];
  warnings: string[];
  symptomCount: number;
  tipCount: number;
};

function loadSchema(ajv: Ajv, schemaDir: string, name: string): ValidateFunction {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8"));
  return ajv.compile(schema);
}

function listYaml(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

function readYaml(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

function schemaErrors(label: string, validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(
    (e) => `${label}: schema: ${e.instancePath || "/"} ${e.message}`,
  );
}

function isStepRef(o: Outcome): o is string {
  return typeof o === "string";
}

function isEscalate(o: Outcome): boolean {
  return typeof o === "object" && "escalate" in o;
}

// Graph checks for one symptom: transitions point to real steps, every step is reachable
// from the first step, and there are no cycles.
function checkTree(label: string, symptom: Symptom): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of symptom.steps) {
    if (ids.has(step.id)) errors.push(`${label}: duplicate step id "${step.id}"`);
    ids.add(step.id);
  }

  const next = new Map<string, string[]>();
  for (const step of symptom.steps) {
    const targets: string[] = [];
    for (const key of ["on_pass", "on_fail"] as const) {
      const o = step[key];
      if (!isStepRef(o)) continue;
      if (!ids.has(o)) errors.push(`${label}: step ${step.id}.${key} -> "${o}" does not exist`);
      else if (o === step.id) errors.push(`${label}: step ${step.id}.${key} points to itself`);
      else targets.push(o);
    }
    next.set(step.id, targets);

    if (step.hazard && !(isEscalate(step.on_pass) && isEscalate(step.on_fail))) {
      errors.push(`${label}: step ${step.id} has hazard: true, so on_pass and on_fail must both be escalate`);
    }
  }

  const first = symptom.steps[0].id;
  const reached = new Set<string>();
  const stack = [first];
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  for (const id of ids) {
    if (!reached.has(id)) errors.push(`${label}: step ${id} is orphaned (not reachable from ${first})`);
  }

  // Cycle detection: white/grey/black DFS.
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    state.set(id, 1);
    for (const n of next.get(id) ?? []) {
      if (state.get(n) === 1) errors.push(`${label}: loop ${[...trail, id, n].join(" -> ")}`);
      else if (!state.has(n)) visit(n, [...trail, id]);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id, []);

  return errors;
}

function checkSourceRef(
  label: string,
  where: string,
  src: SourceRef,
  sources: Map<string, Source>,
  symptomIsSample: boolean,
): string[] {
  const known = sources.get(src.ref);
  if (!known) return [`${label}: ${where} source.ref "${src.ref}" is not in sources.yaml`];
  const errors: string[] = [];
  if (known.type !== src.type) {
    errors.push(`${label}: ${where} source.type "${src.type}" but sources.yaml says "${known.type}"`);
  }
  if (known.sample && !symptomIsSample) {
    errors.push(`${label}: ${where} uses SAMPLE source "${src.ref}" in a non-sample symptom`);
  }
  return errors;
}

export function validateKnowledgeBase(kbDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const schemaDir = path.join(kbDir, "schema");
  const ajv = new Ajv({ allErrors: true });
  const validateSymptom = loadSchema(ajv, schemaDir, "symptom.schema.json");
  const validateTip = loadSchema(ajv, schemaDir, "tip.schema.json");
  const validateSources = loadSchema(ajv, schemaDir, "sources.schema.json");
  const validateDevice = loadSchema(ajv, schemaDir, "device.schema.json");

  // device.yaml
  const devicePath = path.join(kbDir, "device.yaml");
  let deviceVerified = false;
  if (!fs.existsSync(devicePath)) errors.push("device.yaml: missing");
  else {
    const device = readYaml(devicePath) as { verified?: boolean };
    if (!validateDevice(device)) errors.push(...schemaErrors("device.yaml", validateDevice));
    else if (!device.verified) warnings.push("device.yaml: model code / year not verified yet");
    else deviceVerified = true;
  }

  // sources.yaml
  const sources = new Map<string, Source>();
  const sourcesPath = path.join(kbDir, "sources.yaml");
  if (!fs.existsSync(sourcesPath)) errors.push("sources.yaml: missing");
  else {
    const doc = readYaml(sourcesPath) as { sources: Source[] };
    if (!validateSources(doc)) errors.push(...schemaErrors("sources.yaml", validateSources));
    else {
      for (const s of doc.sources) {
        if (sources.has(s.id)) errors.push(`sources.yaml: duplicate id "${s.id}"`);
        if (s.type === "spec" && !s.sample) errors.push(`sources.yaml: "${s.id}" has type spec, so it must be sample: true`);
        sources.set(s.id, s);
      }
    }
  }

  // symptoms/
  const symptoms = new Map<string, Symptom>();
  const symptomDir = path.join(kbDir, "symptoms");
  for (const file of listYaml(symptomDir)) {
    const label = `symptoms/${file}`;
    let data: unknown;
    try {
      data = readYaml(path.join(symptomDir, file));
    } catch (e) {
      errors.push(`${label}: YAML parse error: ${(e as Error).message}`);
      continue;
    }
    if (!validateSymptom(data)) {
      errors.push(...schemaErrors(label, validateSymptom));
      continue;
    }
    const symptom = data as Symptom;
    const expectedId = file.replace(/\.ya?ml$/, "");
    if (symptom.id !== expectedId) errors.push(`${label}: id "${symptom.id}" must match file name "${expectedId}"`);
    if (symptoms.has(symptom.id)) errors.push(`${label}: duplicate symptom id "${symptom.id}"`);
    symptoms.set(symptom.id, symptom);
    if (symptom.sample) warnings.push(`${label}: SAMPLE content, not real knowledge`);
    // Spec: verify model code and year (registration/VIN) before writing real knowledge.
    else if (!deviceVerified) errors.push(`${label}: real symptom needs device.yaml verified: true first`);

    errors.push(...checkTree(label, symptom));
    for (const step of symptom.steps) {
      const sample = symptom.sample === true;
      errors.push(...checkSourceRef(label, `step ${step.id}`, step.source, sources, sample));
      if (step.tip) errors.push(...checkSourceRef(label, `step ${step.id} tip`, step.tip.source, sources, sample));
      const text = [step.check, step.how, step.tip?.text].filter(Boolean).join(" ");
      if (!step.hazard && mentionsHazardTopic(text)) {
        warnings.push(`${label}: step ${step.id} mentions a hazard topic but has hazard: false (review)`);
      }
    }
  }
  if (symptoms.size === 0) errors.push("symptoms/: no symptom files found");

  // tips/
  const tipDir = path.join(kbDir, "tips");
  let tipCount = 0;
  for (const file of listYaml(tipDir)) {
    const label = `tips/${file}`;
    tipCount++;
    let tip: Tip;
    try {
      tip = readYaml(path.join(tipDir, file)) as Tip;
    } catch (e) {
      errors.push(`${label}: YAML parse error: ${(e as Error).message}`);
      continue;
    }
    if (!validateTip(tip)) {
      errors.push(...schemaErrors(label, validateTip));
      continue;
    }
    const symptom = symptoms.get(tip.symptom_id);
    if (!symptom) errors.push(`${label}: symptom_id "${tip.symptom_id}" does not exist`);
    else if (tip.step_id && !symptom.steps.some((s) => s.id === tip.step_id)) {
      errors.push(`${label}: step_id "${tip.step_id}" does not exist in ${tip.symptom_id}`);
    }
  }

  return { errors, warnings, symptomCount: symptoms.size, tipCount };
}
