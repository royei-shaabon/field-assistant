import { span } from "@/lib/server/log";
import { currentEnvId, envStore } from "@/lib/server/env";
import { ingest, MAX_UPLOAD_BYTES, UnsupportedFile } from "@/lib/docs/ingest";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { NotFound } from "@/lib/store";

// Upload one document: read it into passages, then store the passages and the original.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`upload:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  const { kbId } = await params;
  if (tooLarge(request, MAX_UPLOAD_BYTES + 100_000)) return Response.json({ error: "too_large" }, { status: 413 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  const origin = form?.get("origin") === "customer" ? "customer" : "manufacturer";
  const envId = await currentEnvId();
  const stage = span("upload", { env: envId, kb: kbId, bytes: file.size, ext: file.name.slice(file.name.lastIndexOf(".")).toLowerCase().slice(0, 8) });
  const data = Buffer.from(await file.arrayBuffer());
  stage.part("read");
  try {
    const { doc, passages } = await ingest(file.name, data);
    stage.part("extract");
    if (passages.length === 0) {
      stage.end({ outcome: "no_text" });
      return Response.json({ error: "no_text" }, { status: 422 });
    }
    // The same file again would only make search return every page twice.
    const existing = await (await envStore()).listDocs(kbId).catch(() => []);
    stage.part("duplicate_check");
    if (existing.some((d) => d.name === doc.name && d.bytes === doc.bytes)) {
      stage.end({ outcome: "duplicate" });
      return Response.json({ error: "duplicate" }, { status: 409 });
    }
    const meta = await (await envStore()).addDoc(kbId, { ...doc, origin }, passages, data);
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
