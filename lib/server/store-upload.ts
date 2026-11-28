// One uploaded file becomes a document: read into passages, checked against what the knowledge
// base already holds, and stored with the original. Used by the upload in one request and by
// the upload in parts.
import { ingest, UnsupportedFile } from "@/lib/docs/ingest";
import { envStore } from "@/lib/server/env";
import { span } from "@/lib/server/log";
import { docTitle, NotFound } from "@/lib/store";

export async function storeUpload(input: { envId: string; kbId: string; fileName: string; data: Buffer; origin: "manufacturer" | "customer"; given?: string; parts?: number }): Promise<Response> {
  const { envId, kbId, fileName, data, origin } = input;
  const stage = span("upload", { env: envId, kb: kbId, bytes: data.length, chunks: input.parts ?? 1, ext: fileName.slice(fileName.lastIndexOf(".")).toLowerCase().slice(0, 8) });
  stage.part("read");
  try {
    const { doc, passages } = await ingest(fileName, data);
    stage.part("extract");
    if (passages.length === 0) {
      stage.end({ outcome: "no_text" });
      return Response.json({ error: "no_text" }, { status: 422 });
    }
    // The same file again would only make search return every page twice.
    const existing = await (await envStore()).listDocs(kbId).catch(() => []);
    stage.part("duplicate_check");
    if (existing.some((d) => (d.file ?? d.name) === doc.name && d.bytes === doc.bytes)) {
      stage.end({ outcome: "duplicate" });
      return Response.json({ error: "duplicate" }, { status: 409 });
    }
    // The manual's name: what the implementer wrote, or the file's name without its ending.
    const name = docTitle(input.given ?? "", doc.name);
    const meta = await (await envStore()).addDoc(kbId, { ...doc, name, file: doc.name, origin }, passages, data);
    stage.part("store");
    stage.end({ outcome: "stored", doc: meta.id, passages: meta.passages, empty: meta.empty, chars: meta.chars });
    return Response.json({ doc: meta });
  } catch (e) {
    if (e instanceof UnsupportedFile || e instanceof NotFound) {
      stage.end({ outcome: e instanceof NotFound ? "not_found" : "unsupported" });
      return e instanceof NotFound ? Response.json({ error: "not found" }, { status: 404 }) : Response.json({ error: "unsupported" }, { status: 415 });
    }
    stage.fail(e);
    return Response.json({ error: "unreadable" }, { status: 422 });
  }
}
