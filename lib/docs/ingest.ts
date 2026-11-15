// Turns an uploaded file into numbered passages. A PDF keeps its real page numbers, so a source
// chip can say "page 52". Everything else is cut into parts at paragraph boundaries.
import path from "node:path";
import type { DocMeta, Passage } from "../store/types";

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const PART_CHARS = 1800;

export class UnsupportedFile extends Error {}

type Kind = "pdf" | "docx" | "text" | "html";

const KINDS: Record<string, { kind: Kind; mime: string }> = {
  ".pdf": { kind: "pdf", mime: "application/pdf" },
  ".docx": { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".txt": { kind: "text", mime: "text/plain; charset=utf-8" },
  ".md": { kind: "text", mime: "text/markdown; charset=utf-8" },
  ".csv": { kind: "text", mime: "text/csv; charset=utf-8" },
  ".json": { kind: "text", mime: "application/json; charset=utf-8" },
  ".html": { kind: "html", mime: "text/html; charset=utf-8" },
  ".htm": { kind: "html", mime: "text/html; charset=utf-8" },
};

export const ACCEPTED_EXTENSIONS = Object.keys(KINDS);

const clean = (text: string) =>
  text
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Cuts long text into parts of about PART_CHARS, never in the middle of a paragraph when a
// paragraph fits.
export function splitIntoParts(text: string, size = PART_CHARS): string[] {
  const parts: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const paragraph of clean(text).split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > size) push();
    if (paragraph.length <= size) {
      current += (current ? "\n\n" : "") + paragraph;
      continue;
    }
    // A single huge paragraph (a CSV, a wall of text): cut at line or sentence ends.
    for (const piece of paragraph.split(/(?<=\n)|(?<=[.!?]) /)) {
      if (current.length + piece.length > size) push();
      current += piece;
    }
  }
  push();
  return parts;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function pdfPages(data: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map(clean);
}

async function docxText(data: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: data })).value;
}

export type Ingested = { doc: Omit<DocMeta, "id" | "kbId" | "uploadedAt" | "origin">; passages: Passage[] };

export async function ingest(fileName: string, data: Buffer): Promise<Ingested> {
  const ext = path.extname(fileName).toLowerCase();
  const type = KINDS[ext];
  if (!type) throw new UnsupportedFile(ext || fileName);
  if (data.length > MAX_UPLOAD_BYTES) throw new UnsupportedFile("too large");

  let passages: Passage[];
  let unit: DocMeta["unit"] = "part";
  let total: number;
  if (type.kind === "pdf") {
    unit = "page";
    const pages = await pdfPages(data);
    total = pages.length;
    passages = pages.map((text, i) => ({ n: i + 1, text })).filter((p) => p.text.length > 0);
  } else {
    const raw = type.kind === "docx" ? await docxText(data) : data.toString("utf8");
    passages = splitIntoParts(type.kind === "html" ? htmlToText(raw) : raw).map((text, i) => ({ n: i + 1, text }));
    total = passages.length;
  }

  const name = path.basename(fileName, path.extname(fileName)).replace(/[_]+/g, " ").trim().slice(0, 120) || "מסמך";
  return {
    doc: {
      name,
      unit,
      mime: type.mime,
      ext,
      bytes: data.length,
      passages: total,
      empty: total - passages.length,
      chars: passages.reduce((n, p) => n + p.text.length, 0),
    },
    passages,
  };
}
