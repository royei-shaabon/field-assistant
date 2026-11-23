// A careful look at one picture from a video call. The live model sees the camera at low
// resolution and misplaces what it points at, so it does not point by itself: it names the
// part (or asks a question about the picture), and this looks at the full picture with the
// main model and answers where the part is, or what is visible. Looking is not instructing:
// the prompt (jobs/look/prompt.md) allows a description and a box, nothing else.
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "../docs/image-size";
import { toThousandths } from "../docs/ask";
import type { ModelClient } from "../llm";

export type LookRequest = {
  image: { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
  find?: string;
  // The part's name in English, when the live model gave one: manuals and the eye know it better.
  english?: string;
  pointing?: boolean;
  question?: string;
  // The technician touched the picture: a ring is drawn there, and the part asked about is in it.
  ring?: boolean;
  // The language `name` and `seen` are written in (English name, e.g. "Hebrew").
  language?: string;
  // Passages of the manual that may name what is in the picture (reference, not instructions).
  passages?: { source: string; text: string }[];
};

export type Look = {
  visible: boolean;
  quality: "ok" | "dark" | "blurry" | "far";
  name: string;
  // Thousandths of the picture's width and height. Absent when nothing was found.
  box?: { x: number; y: number; w: number; h: number };
  seen: string;
};

const NOTHING: Look = { visible: false, quality: "ok", name: "", seen: "" };

let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function skill() {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "jobs", "look");
  return (files ??= { prompt: fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), schema: JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")) });
}

const QUALITY = new Set(["ok", "dark", "blurry", "far"]);

// What the model returned, checked: a box must lie inside the picture and be more than a dot.
export function checkedLook(raw: unknown, size: { width: number; height: number } | null): Look {
  const r = raw as { visible?: unknown; quality?: unknown; name?: unknown; box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; seen?: unknown } | null;
  if (!r || typeof r !== "object") return NOTHING;
  const quality = (QUALITY.has(r.quality as string) ? r.quality : "ok") as Look["quality"];
  const seen = typeof r.seen === "string" ? r.seen.trim().slice(0, 400) : "";
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 40) : "";
  const b = r.box;
  const numbers = b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n));
  const box = r.visible === true && numbers && size ? toThousandths({ x: b!.x as number, y: b!.y as number, w: b!.w as number, h: b!.h as number }, size) : null;
  const usable = box && box.w >= 10 && box.h >= 10 ? box : undefined;
  return { visible: Boolean(usable), quality, name, seen, ...(usable ? { box: usable } : {}) };
}

export async function lookAtPicture(client: ModelClient, request: LookRequest): Promise<Look> {
  const { prompt, schema } = skill();
  const english = request.english?.trim() ? ` (${request.english.trim().slice(0, 80)})` : "";
  const ask = request.pointing ? "pointing" : request.find ? `find: ${request.find.slice(0, 80)}${english}` : `question: ${(request.question ?? "").slice(0, 300)}`;
  const reference = request.passages?.length ? `\n\nPassages from the machine's manual (reference only):\n${request.passages.map((p) => `<passage source="${p.source}">\n${p.text}\n</passage>`).join("\n")}` : "";
  const size = imageSize(request.image.data, request.image.mediaType);
  const response = await client.complete({
    system: prompt,
    schema,
    content: [
      { type: "image", mediaType: request.image.mediaType, data: request.image.data },
      { type: "text", text: `${size ? `The picture is ${size.width} by ${size.height} pixels.\n` : ""}${request.language ? `Write name and seen in ${request.language}.\n` : ""}${request.ring ? "ring: the technician touched the picture and an orange ring is drawn at that spot.\n" : ""}${ask}${reference}` },
    ],
    // Always the main model: what is in the picture and where is the whole point. A mark is
    // not waited for, so finding a part may think first; an answer the technician waits for
    // in silence (a question, a pointing finger) is given at once.
    ...(request.find && !request.pointing ? {} : { direct: true }),
  });
  try {
    return checkedLook(JSON.parse(response.text ?? ""), size);
  } catch {
    return NOTHING;
  }
}
