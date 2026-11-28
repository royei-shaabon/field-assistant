// Pages that text extraction cannot read: a scanned page has no text at all, and a table whose
// cells are symbols comes out as bare numbers. The main model reads such a page from its picture
// and writes down what is printed. What it wrote is kept after the page's own text and is
// searched and quoted like it, and an answer that leans on it says so ("read from a picture"):
// a model read it, not the file.
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm";
import type { KbStore } from "../store";
import type { DocMeta, Passage } from "../store/types";

// Tables in one document that are read. A parts catalogue is all tables, and its text is
// already whole: the implementer starts the reading, and this bounds what one press costs.
export const MAX_TABLE_PAGES = 80;
const MAX_READ_CHARS = 6000;
const AT_ONCE = 3;

// A page whose text is mostly numbers standing alone: the layout of a table that lost its cells.
export function looksLikeTable(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 60) return false;
  const numbers = words.filter((w) => /^[\d.,×x*\-–/()%°±]+$/.test(w) && /\d/.test(w)).length;
  return numbers / words.length >= 0.3;
}

export type ToRead = { empty: number[]; tables: number[] };

// The pages still waiting: pages of a PDF with no text, and pages that look like tables, most
// table-like first. A page that was read once is not read again.
export function pagesToRead(meta: Pick<DocMeta, "unit" | "passages" | "pictured">, passages: Passage[]): ToRead {
  if (meta.unit !== "page") return { empty: [], tables: [] };
  const done = new Set(meta.pictured ?? []);
  const have = new Set(passages.map((p) => p.n));
  const empty = Array.from({ length: meta.passages }, (_, i) => i + 1).filter((n) => !have.has(n) && !done.has(n));
  const tables = passages
    .filter((p) => !done.has(p.n) && p.own === undefined && looksLikeTable(p.text))
    .map((p) => p.n)
    .slice(0, Math.max(0, MAX_TABLE_PAGES - (meta.pictured?.length ?? 0)));
  return { empty, tables };
}

let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function job() {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "jobs", "read");
  return (files ??= { prompt: fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), schema: JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")) });
}

export type PagePicture = { data: string; mediaType: "image/png" };

// What the model read on one page. An empty text when it added nothing. Throws when the model
// could not be asked, so the page stays waiting.
export async function readPage(client: ModelClient, picture: PagePicture, extracted: string): Promise<string> {
  const { prompt, schema } = job();
  const response = await client.complete({
    system: prompt,
    schema,
    content: [
      { type: "image", data: picture.data, mediaType: picture.mediaType },
      { type: "text", text: `Extracted text of this page:\n<extracted>\n${extracted.slice(0, 6000).replace(/<\/?extracted>/gi, "")}\n</extracted>` },
    ],
  });
  const reply = JSON.parse(response.text ?? "") as { kind?: unknown; text?: unknown };
  if (reply.kind === "nothing" || typeof reply.text !== "string") return "";
  return reply.text.replace(/\r/g, "").trim().slice(0, MAX_READ_CHARS);
}

export type ReadProgress = { read: number; left: number; failed: number };

// Reads waiting pages for a bounded time and stores what was read. The implementer's screen
// calls again until nothing is left.
export async function readPages(
  store: KbStore,
  client: ModelClient,
  kbId: string,
  docId: string,
  picture: (n: number) => Promise<PagePicture | null>,
  budgetMs = 40_000,
): Promise<ReadProgress> {
  const started = Date.now();
  const loaded = await store.getPassages(kbId, docId);
  const meta = (await store.listDocs(kbId)).find((d) => d.id === docId);
  if (!loaded || !meta) return { read: 0, left: 0, failed: 0 };
  const waiting = pagesToRead(meta, loaded.passages);
  const todo = [...waiting.empty, ...waiting.tables];
  const text = new Map(loaded.passages.map((p) => [p.n, p.text]));
  let read = 0;
  let failed = 0;
  let at = 0;
  while (at < todo.length && Date.now() - started < budgetMs) {
    const batch = todo.slice(at, at + AT_ONCE);
    at += batch.length;
    const results = await Promise.allSettled(
      batch.map(async (n) => {
        const image = await picture(n);
        // A page that cannot be drawn is done: asking again would not change it.
        return { n, seen: image ? await readPage(client, image, text.get(n) ?? "") : "" };
      }),
    );
    const done = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    failed += results.length - done.length;
    if (done.length) await store.addSeen(kbId, docId, done);
    read += done.length;
    // The model is not answering: stop, and let the next call try again.
    if (!done.length) break;
  }
  return { read, left: todo.length - read, failed };
}
