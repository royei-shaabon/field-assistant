import { ingest, MAX_UPLOAD_BYTES, UnsupportedFile } from "@/lib/docs/ingest";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { ensureSeed } from "@/lib/server/kbs";
import { kbStore, NotFound } from "@/lib/store";

// Upload one document: read it into passages, then store the passages and the original.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId } = await params;
  await ensureSeed();
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  const origin = form?.get("origin") === "customer" ? "customer" : "manufacturer";
  const data = Buffer.from(await file.arrayBuffer());
  try {
    const { doc, passages } = await ingest(file.name, data);
    if (passages.length === 0) return Response.json({ error: "no_text" }, { status: 422 });
    // The same file again would only make search return every page twice.
    const existing = await kbStore().listDocs(kbId).catch(() => []);
    if (existing.some((d) => d.name === doc.name && d.bytes === doc.bytes)) return Response.json({ error: "duplicate" }, { status: 409 });
    const meta = await kbStore().addDoc(kbId, { ...doc, origin }, passages, data);
    return Response.json({ doc: meta });
  } catch (e) {
    if (e instanceof UnsupportedFile) return Response.json({ error: "unsupported" }, { status: 415 });
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    console.error("[upload]", e);
    return Response.json({ error: "unreadable" }, { status: 422 });
  }
}
