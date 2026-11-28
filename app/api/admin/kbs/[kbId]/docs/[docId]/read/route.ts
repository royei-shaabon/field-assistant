import { pageImage } from "@/lib/docs/page-image";
import { pagesToRead, readPages } from "@/lib/docs/read-pages";
import { AnthropicModelClient } from "@/lib/llm";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { span } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { NotFound } from "@/lib/store";

let client: AnthropicModelClient | undefined;

// Which pages of the document wait to be read from their picture.
export async function GET(_request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  const { kbId, docId } = await params;
  const store = await envStore();
  const [meta, loaded] = await Promise.all([store.listDocs(kbId).then((docs) => docs.find((d) => d.id === docId)).catch(() => undefined), store.getPassages(kbId, docId).catch(() => null)]);
  if (!meta || !loaded) return Response.json({ error: "not found" }, { status: 404 });
  const waiting = pagesToRead(meta, loaded.passages);
  return Response.json({ empty: waiting.empty.length, tables: waiting.tables.length, read: meta.pictured?.length ?? 0 }, { headers: { "Cache-Control": "no-store" } });
}

// Reads waiting pages for a bounded time. The implementer's screen calls again until none is left.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`read-pages:${clientKey(request)}`, LIMITS.readPages)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const { kbId, docId } = await params;
  const envId = await currentEnvId();
  const stage = span("read.step", { env: envId, kb: kbId, doc: docId });
  try {
    const store = await envStore();
    client ??= new AnthropicModelClient();
    const progress = await readPages(store, client, kbId, docId, async (n) => {
      const image = await pageImage(kbId, docId, n, store, envId);
      return image && { data: image.png.toString("base64"), mediaType: "image/png" as const };
    });
    stage.end({ ...progress });
    return Response.json(progress, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof NotFound) {
      stage.end({ outcome: "not_found" });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    stage.fail(e);
    return Response.json({ error: "read_failed" }, { status: 502 });
  }
}
