import { embedder } from "@/lib/docs/embed";
import { currentEnvId } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { activity } from "@/lib/store";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { loadDocKb } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { liveLookup } from "@/lib/voice/lookup";

// The live call's tool: a fast search over the machine's documents (lib/voice/lookup.ts).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`lookup:${clientKey(request)}`, LIMITS.lookup)) return tooMany();
  if (tooLarge(request, 4000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; question?: unknown; english?: unknown; conversationId?: unknown; video?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 500) : "";
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  if (!kb) return Response.json({ error: "unknown knowledge base" }, { status: 400 });
  if (!question) return Response.json({ error: "no question" }, { status: 400 });
  const envId = await currentEnvId();
  const started = Date.now();
  const result = { ...(await liveLookup(kb.index, question, embedder(), typeof body?.english === "string" ? body.english : undefined)), general_checks_allowed: kb.meta.ideas !== false };
  const ms = Date.now() - started;
  log.info("live.lookup", { env: envId, kb: kb.meta.id, ms, passages: result.passages.length, caution: Boolean(result.caution) });
  if (ms > 3000) log.warn("live.lookup_slow", { env: envId, kb: kb.meta.id, ms });
  // What was asked in the call, and that the live model answered it from these pages.
  const book = activity(envId);
  await book
    .record({ kbId: kb.meta.id, kbName: kb.meta.name, conversationId: typeof body?.conversationId === "string" ? body.conversationId : undefined, channel: body?.video === true ? "video" : "voice", question, kind: result.kind === "passages" ? "spoken" : "not_found", sources: result.passages.map((p) => p.source), ms })
    .catch((e) => log.error("record.failed", e, { env: envId }));
  await book.measure((day) => ((day.lookups += 1), void (day.lookupMs += ms))).catch(() => {});
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
