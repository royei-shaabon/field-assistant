// identify skill: photos / video frames and/or text -> up to 3 candidate symptoms from the KB
// catalog, plus boxes that point at visual cues in the images.
import type { KnowledgeBase } from "../kb";
import { symptomCatalog } from "../kb";
import type { ModelClient, SkillContent } from "../llm";
import { MAX_CANDIDATES, validMarks, type IdentifyResult } from "../safety";
import { loadSkillFiles, runSkill, type SkillFiles, type SkillRun } from "./run-skill";

export const IDENTIFY_FALLBACK: IdentifyResult = { candidates: [], reason: "invalid model output", marks: [] };

export type ImageContent = Extract<SkillContent, { type: "image" }>;

export type IdentifyInput = {
  catalog: ReturnType<typeof symptomCatalog>;
  description?: string;
  images?: ImageContent[];
  media?: "photo" | "video";
};

export function identifyInput(
  kb: KnowledgeBase,
  description?: string,
  images?: ImageContent[],
  media?: "photo" | "video",
): IdentifyInput {
  return { catalog: symptomCatalog(kb), description, images, media };
}

// The schema sent to the API narrows every symptom_id to the catalog ids (plus "unknown").
export function identifyRequestSchema(files: SkillFiles, ids: string[]): Record<string, unknown> {
  type Obj = { properties: Record<string, Obj & { items: Obj }>; [k: string]: unknown };
  const schema = structuredClone(files.schema) as Obj;
  schema.properties.candidates.items.properties.symptom_id = { type: "string", enum: [...ids, "unknown"] } as never;
  schema.properties.marks.items.properties.symptom_id = { type: "string", enum: ids } as never;
  return schema;
}

export async function identify(
  client: ModelClient,
  input: IdentifyInput,
  files: SkillFiles = loadSkillFiles("identify"),
): Promise<SkillRun<IdentifyResult>> {
  const ids = input.catalog.map((s) => s.id);
  const images = input.images ?? [];
  const content: SkillContent[] = [
    ...images,
    {
      type: "text",
      text: JSON.stringify({
        catalog: input.catalog,
        description: input.description ?? "",
        frames: images.length,
        media: images.length ? (input.media ?? "photo") : "none",
      }),
    },
  ];
  const run = await runSkill<IdentifyResult>({
    client,
    files,
    content,
    requestSchema: identifyRequestSchema(files, ids),
    check: (o) => {
      if (o.candidates.length < 1 || o.candidates.length > MAX_CANDIDATES) return `expected 1-${MAX_CANDIDATES} candidates`;
      const bad = o.candidates.find((c) => c.symptom_id !== "unknown" && !ids.includes(c.symptom_id));
      return bad ? `symptom_id "${bad.symptom_id}" not in catalog` : null;
    },
    fallback: IDENTIFY_FALLBACK,
  });
  // Marks are secondary: drop the ones that do not point at a real frame and cue instead of retrying.
  const cues = new Map(input.catalog.map((s) => [s.id, s.visual_cues.length]));
  const marks = validMarks((id) => cues.get(id), run.output, images.length);
  return { ...run, output: { ...run.output, marks } };
}
