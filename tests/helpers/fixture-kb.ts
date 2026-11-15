// In-memory SAMPLE knowledge base for orchestrator/safety tests. No real NMAX knowledge.
import type { KnowledgeBase, Source, Step, Symptom } from "../../lib/kb";

const manual = (page: number) => ({ type: "manual" as const, ref: "sample-manual", page });

function step(id: string, on_pass: Step["on_pass"], on_fail: Step["on_fail"], extra: Partial<Step> = {}): Step {
  return { id, check: `SAMPLE בדיקה ${id}`, source: manual(1), hazard: false, on_pass, on_fail, ...extra };
}

const sources: Source[] = [
  { id: "sample-manual", type: "manual", title: "SAMPLE מדריך", date: "2026-10-28", sample: true },
  { id: "sample-mechanic", type: "mechanic", title: "SAMPLE מכונאי", date: "2026-10-28", sample: true },
];

const symptoms: Symptom[] = [
  {
    // s1 -> s2 -> s3 -> s4 -> s5 on pass; escalate_after_steps is 3
    id: "sample-chain",
    title: "SAMPLE שרשרת",
    sample: true,
    visual_cues: ["SAMPLE"],
    escalate_after_steps: 3,
    steps: [
      step("s1", "s2", { resolve: "SAMPLE פתרון 1" }, { how: "SAMPLE איך 1" }),
      step("s2", "s3", { escalate: "SAMPLE הסלמה 2" }, {
        tip: { author: "SAMPLE מכונאי", text: "SAMPLE טיפ 2", source: { type: "mechanic", ref: "sample-mechanic" } },
        conflict: true,
      }),
      step("s3", "s4", { resolve: "SAMPLE פתרון 3" }),
      step("s4", "s5", { resolve: "SAMPLE פתרון 4" }),
      step("s5", { resolve: "SAMPLE פתרון 5" }, { resolve: "SAMPLE פתרון 5" }),
    ],
  },
  {
    id: "sample-hazard-first",
    title: "SAMPLE מסוכן מההתחלה",
    sample: true,
    visual_cues: ["SAMPLE"],
    escalate_after_steps: 6,
    steps: [
      step("s1", { escalate: "SAMPLE מסוכן" }, { escalate: "SAMPLE מסוכן" }, {
        hazard: true,
        check: "SAMPLE טקסט מסוכן שאסור להציג",
        how: "SAMPLE הוראה מסוכנת שאסור להציג",
      }),
    ],
  },
  {
    // s1 pass -> s2 (hazard); s1 fail -> resolve
    id: "sample-hazard-second",
    title: "SAMPLE מסוכן בצעד שני",
    sample: true,
    visual_cues: ["SAMPLE"],
    escalate_after_steps: 6,
    steps: [
      step("s1", "s2", { resolve: "SAMPLE פתרון" }),
      step("s2", { escalate: "SAMPLE מסוכן" }, { escalate: "SAMPLE מסוכן" }, {
        hazard: true,
        check: "SAMPLE טקסט מסוכן שאסור להציג",
      }),
    ],
  },
  {
    // one step: pass resolves, fail escalates
    id: "sample-short",
    title: "SAMPLE קצר",
    sample: true,
    visual_cues: ["SAMPLE רמז א", "SAMPLE רמז ב"],
    escalate_after_steps: 6,
    steps: [step("s1", { resolve: "SAMPLE פתרון קצר" }, { escalate: "SAMPLE הסלמה קצרה" })],
  },
];

export function fixtureKb(): KnowledgeBase {
  return {
    sources: new Map(sources.map((s) => [s.id, s])),
    symptoms: new Map(symptoms.map((s) => [s.id, structuredClone(s)])),
  };
}

// Every string a step view may legally contain: text that exists in the KB.
export function kbStrings(kb: KnowledgeBase): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk([...kb.sources.values()]);
  walk([...kb.symptoms.values()]);
  return out;
}
