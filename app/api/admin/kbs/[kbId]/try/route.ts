import { embedder } from "@/lib/docs/embed";
import { modelTranslator } from "@/lib/docs/english";
import { modelReranker } from "@/lib/docs/rerank";
import { AnthropicModelClient } from "@/lib/llm";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { aiConfigured, loadDocKb } from "@/lib/server/kbs";
import { span } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { liveLookup } from "@/lib/voice/lookup";

let client: AnthropicModelClient | undefined;

// The implementer tries a question against a knowledge base and sees what the search finds:
// which pages, which sections, in what order. The same search a call uses, so a manual can be
// checked before a technician asks. Nothing is written to the conversation log.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`lookup:${clientKey(request)}`, LIMITS.lookup)) return tooMany();
  if (tooLarge(request, 4000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 500) : "";
  const { kbId } = await params;
  const stage = span("admin.try", { kb: kbId.slice(0, 60) });
  const kb = await loadDocKb(kbId);
  stage.part("load");
  if (!kb || !question) {
    stage.end({ outcome: "bad_request" });
    return Response.json({ error: kb ? "no question" : "not found" }, { status: kb ? 400 : 404 });
  }
  // Without a model the search still runs, by words and meaning, in its own order.
  const model = aiConfigured() ? (client ??= new AnthropicModelClient()) : null;
  const parts: Record<string, number> = {};
  try {
    const found = await liveLookup(kb.index, question, embedder(), undefined, model ? modelReranker(model) : undefined, (part, ms) => ((parts[part] = ms), stage.add(part, ms)), model ? modelTranslator(model) : undefined);
    const ms = stage.end({ passages: found.passages.length });
    return Response.json(
      { kind: found.kind, passages: found.passages.map((p) => ({ source: p.source, text: p.text.slice(0, 1200) })), caution: found.caution ?? null, ms, parts, byMeaning: Boolean(embedder()) && kb.index.vectorCount > 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    stage.fail(e);
    return Response.json({ error: "failed" }, { status: 502 });
  }
}
