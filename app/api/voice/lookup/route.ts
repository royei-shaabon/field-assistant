import { embedder } from "@/lib/docs/embed";
import { modelReranker } from "@/lib/docs/rerank";
import { AnthropicModelClient } from "@/lib/llm";
import { currentEnvId } from "@/lib/server/env";
import { log, span } from "@/lib/server/log";
import { activity } from "@/lib/store";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { loadDocKb } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { liveLookup } from "@/lib/voice/lookup";

let client: AnthropicModelClient | undefined;

// The live call's tool: a fast search over the machine's documents (lib/voice/lookup.ts).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`lookup:${clientKey(request)}`, LIMITS.lookup)) return tooMany();
  if (tooLarge(request, 4000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; question?: unknown; english?: unknown; conversationId?: unknown; video?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 500) : "";
  const envId = await currentEnvId();
  const stage = span("live.lookup", { env: envId, kb: typeof body?.kbId === "string" ? body.kbId.slice(0, 60) : "", video: body?.video === true });
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  stage.part("load");
  if (!kb || !question) {
    stage.end({ outcome: "bad_request" });
    return Response.json({ error: kb ? "no question" : "unknown knowledge base" }, { status: 400 });
  }
  client ??= new AnthropicModelClient();
  // embed, match and rerank are timed inside the lookup; what is left here is glue.
  const found = await liveLookup(kb.index, question, embedder(), typeof body?.english === "string" ? body.english : undefined, modelReranker(client), (part, ms) => stage.add(part, ms)).catch((e) => {
    stage.fail(e);
    throw e;
  });
  const result = { ...found, general_checks_allowed: kb.meta.ideas !== false };
  stage.part("lookup");
  // What was asked in the call, and that the live model answered it from these pages.
  const book = activity(envId);
  await book
    .record({ kbId: kb.meta.id, kbName: kb.meta.name, conversationId: typeof body?.conversationId === "string" ? body.conversationId : undefined, channel: body?.video === true ? "video" : "voice", question, kind: result.kind === "passages" ? "spoken" : "not_found", sources: result.passages.map((p) => p.source) })
    .catch((e) => log.error("record.failed", e, { env: envId }));
  stage.part("record");
  const ms = stage.end({ passages: result.passages.length, caution: Boolean(result.caution), chars: result.passages.reduce((n, p) => n + p.text.length, 0) });
  if (ms > 3000) log.warn("live.lookup_slow", { env: envId, kb: kb.meta.id, ms });
  await book.measure((day) => ((day.lookups += 1), void (day.lookupMs += ms))).catch(() => {});
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
