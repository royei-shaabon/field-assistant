import { currentEnvId, envStore } from "@/lib/server/env";
import { log, span } from "@/lib/server/log";
import { channelOf, recordTurn } from "@/lib/server/record";
import { activity } from "@/lib/store";
import type { AskTiming } from "@/lib/docs/ask";
import { loadKnowledgeBase, type KnowledgeBase } from "@/lib/kb";
import { BadRequest, handleConversation } from "@/lib/conversation";
import { handleDocConversation } from "@/lib/docs/conversation";
import { embedder } from "@/lib/docs/embed";
import { pageImage } from "@/lib/docs/page-image";
import { AnthropicModelClient } from "@/lib/llm";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { measuringRun } from "@/lib/server/admin-auth";
import { loadDocKb, SAMPLE_KB_ID, sampleKbVisible } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { isMeasuring } from "@/lib/store/activity";

let sample: KnowledgeBase | undefined;
let client: AnthropicModelClient | undefined;

// Streams newline-delimited JSON: {"progress": ..., "detail"?: ...} lines while the server
// works (real stages: before and after each model call and each search), then one
// {"result": ...} line, or {"error": ...}. The body names the knowledge base (kbId).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  // Six photos of 1.5MB each plus the event log is the most a real request carries.
  if (tooLarge(request, 12_000_000)) return Response.json({ error: "too large" }, { status: 413 });
  client ??= new AnthropicModelClient();
  const raw = (await request.json().catch(() => null)) as { kbId?: unknown; events?: unknown; input?: unknown; conversationId?: unknown; channel?: unknown } | null;
  const kbId = typeof raw?.kbId === "string" ? raw.kbId : "";
  // Looking at a saved conversation is free; anything else may call the model.
  // Looking at a saved conversation, or adding a call's transcript to it, asks no model.
  const inputKind = (raw?.input as { kind?: unknown } | undefined)?.kind;
  const asks = inputKind !== "view" && inputKind !== "call_log";
  if (asks && !(await measuringRun(request)) && (!allow(`ask:${clientKey(request)}`, LIMITS.ask) || !allow("ask:all", LIMITS.askDaily))) {
    log.warn("ask.rate_limited", { env: await currentEnvId(), kb: kbId });
    return tooMany();
  }
  const body = raw && { events: raw.events, input: raw.input };
  // How the first search runs. FIRST_SEARCH sets it for the service; the header lets
  // scripts/live-check.ts compare the ways on one deployment. All three only read documents.
  const wanted = request.headers.get("x-first-search") ?? process.env.FIRST_SEARCH;
  const firstSearch = wanted === "sequential" || wanted === "parallel" || wanted === "meaning" ? wanted : undefined;
  const encoder = new TextEncoder();
  const envId = await currentEnvId();
  const store = await envStore();
  const meta = { conversationId: typeof raw?.conversationId === "string" ? raw.conversationId : undefined, channel: channelOf(raw?.channel) };
  // One stage per question: loading the knowledge base, the answer (with the parts the answer
  // engine measures itself), and writing it down. Looking at a saved conversation is not timed.
  const stage = asks ? span("ask", { env: envId, kb: kbId, channel: meta.channel }) : null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: object) => controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      try {
        if (kbId === SAMPLE_KB_ID && sampleKbVisible()) {
          sample ??= loadKnowledgeBase();
          const result = await handleConversation(sample, client!, body, (p) => send({ progress: p }));
          stage?.part("answer");
          stage?.end({ kind: "fault_tree" });
          send({ result });
        } else {
          let timing: AskTiming | undefined;
          const kb = await loadDocKb(kbId);
          stage?.part("load");
          if (!kb) throw new BadRequest("unknown knowledge base");
          const result = await handleDocConversation(kb, client!, body, (p) => send({ progress: p.stage === "reading" ? "pages" : p.stage, detail: p.detail }), request.signal, {
            // Each verified step goes to the phone as soon as it is written.
            onPartial: (partial) => send({ partial }),
            embedder: embedder(),
            firstSearch,
            // Where the time went: numbers only, for the log and for scripts/live-check.ts.
            onTiming: (t) => {
              timing = t;
              // Each stage of the answer, in milliseconds: the small model's plan, the first
              // search, the page pictures, every turn of the main model, and the skills it ran.
              log.info("ask.timing", { env: envId, kb: kbId, ms: t.total, firstStepMs: t.firstStep, firstTitleMs: t.firstTitle ?? null, planMs: t.plan, searchMs: t.search, imagesMs: t.images, toolsMs: t.tools, turns: t.turns.length, turnMs: t.turns.map((x) => x.total), firstTextMs: t.turns.map((x) => x.firstText), cached: t.turns.reduce((n, x) => n + (x.usage?.cached ?? 0), 0), fresh: t.turns.reduce((n, x) => n + (x.usage?.fresh ?? 0), 0), output: t.turns.reduce((n, x) => n + (x.usage?.output ?? 0), 0) });
              if (t.total > 15_000) log.warn("ask.slow", { env: envId, kb: kbId, ms: t.total });
              send({ timing: t });
            },
            // An experiment header, like x-first-search: answer without the pages as pictures, to measure what they cost.
            pageImage: request.headers.get("x-page-images") === "off" ? undefined : async (hit) => {
              const image = await pageImage(kbId, hit.docId, hit.n, store, envId);
              return image && { data: image.png.toString("base64"), mediaType: "image/png" as const, width: image.width, height: image.height };
            },
          });
          // A new turn was added: count it, write it down, and log how it ended.
          stage?.part("answer");
          const before = Array.isArray(body?.events) ? body.events.length : 0;
          const event = result.events.length > before ? result.events.at(-1)! : null;
          if (event?.type === "DOC_TURN") {
            if (!isMeasuring(meta.conversationId)) await store.recordUsage(kbId, event.result.kind).catch(() => {});
            await recordTurn(envId, { id: kbId, name: kb.meta.name }, event, meta, timing);
            stage?.part("record");
            const t = timing;
            // The answer's own parts: the small model's plan, the first search, page pictures, the
            // main model's turns, the skills it ran. They add up to "answer" above.
            if (t) for (const [name, ms] of [["plan", t.plan], ["search", t.search], ["images", t.images], ["model", t.turns.reduce((n, x) => n + x.total, 0)], ["tools", t.tools]] as const) stage?.add(`answer.${name}`, ms);
            stage?.end({ kind: event.result.kind, steps: event.result.kind === "answer" ? event.result.steps.length : 0, stepsWritten: t?.written ?? null, firstStepMs: t?.firstStep ?? null, turns: t?.turns.length ?? 0 });
          } else stage?.end({ kind: "none" });
          send({ result });
        }
      } catch (e) {
        if (e instanceof BadRequest) {
          log.warn("ask.rejected", { env: envId, kb: kbId, reason: e.message });
          stage?.end({ kind: "rejected" });
        } else {
          stage?.fail(e);
          await activity(envId).measure((day) => void day.errors++).catch(() => {});
        }
        send({ error: e instanceof BadRequest ? e.message : "server error" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
