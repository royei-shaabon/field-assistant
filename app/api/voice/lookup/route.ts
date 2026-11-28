import { embedder } from "@/lib/docs/embed";
import { modelTranslator } from "@/lib/docs/english";
import { modelReranker } from "@/lib/docs/rerank";
import { AnthropicModelClient } from "@/lib/llm";
import { currentEnvId, envStore } from "@/lib/server/env";
import { log, span } from "@/lib/server/log";
import { activity, audienceOf } from "@/lib/store";
import { isMeasuring } from "@/lib/store/activity";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { measuringRun } from "@/lib/server/admin-auth";
import { loadDocKb } from "@/lib/server/kbs";
import { sameQuestionKey } from "@/lib/same-question";
import { Recent } from "@/lib/server/recent";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { liveLookup, type LiveLookup } from "@/lib/voice/lookup";

let client: AnthropicModelClient | undefined;
// In a call the model often asks the same thing twice (the technician repeats, the model
// re-checks). A repeat within ten minutes, on the same version of the manuals, is not searched again.
const recent = new Recent<LiveLookup>(300, 10 * 60_000);

// The live call's tool: a fast search over the machine's documents (lib/voice/lookup.ts).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!(await measuringRun(request)) && !allow(`lookup:${clientKey(request)}`, LIMITS.lookup)) return tooMany();
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
  const english = typeof body?.english === "string" ? body.english : undefined;
  const audience = audienceOf(await (await envStore()).getSettings().catch(() => ({})));
  const key = `${envId}/${audience}/${kb.meta.id}/${kb.meta.updatedAt}/${sameQuestionKey(question)}/${sameQuestionKey(english ?? "")}`;
  const cached = recent.get(key);
  // embed, match and rerank are timed inside the lookup; what is left here is glue.
  const found =
    cached ??
    (await liveLookup(kb.index, question, embedder(), english, modelReranker(client), (part, ms) => stage.add(part, ms), modelTranslator(client), audience).catch((e) => {
      stage.fail(e);
      throw e;
    }));
  if (!cached) recent.set(key, found);
  const result = { ...found, general_checks_allowed: kb.meta.ideas !== false };
  stage.part("lookup");
  // What was asked in the call, and that the live model answered it from these pages.
  // A measuring script's question is answered and timed in the log line, and not written down.
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId.slice(0, 80) : undefined;
  const measuring = isMeasuring(conversationId);
  const book = activity(envId);
  if (!measuring)
    await book
      .record({ kbId: kb.meta.id, kbName: kb.meta.name, conversationId, channel: body?.video === true ? "video" : "voice", question, kind: result.kind === "passages" ? "spoken" : "not_found", sources: result.passages.map((p) => p.source) })
      .catch((e) => log.error("record.failed", e, { env: envId }));
  stage.part("record");
  const ms = stage.end({ measuring, cached: Boolean(cached), passages: result.passages.length, caution: Boolean(result.caution), chars: result.passages.reduce((n, p) => n + p.text.length, 0) });
  if (ms > 3000) log.warn("live.lookup_slow", { env: envId, kb: kb.meta.id, ms });
  if (!measuring) await book.measure((day) => ((day.lookups += 1), void (day.lookupMs += ms))).catch(() => {});
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
