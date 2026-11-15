import { loadKnowledgeBase, type KnowledgeBase } from "@/lib/kb";
import { BadRequest, handleConversation } from "@/lib/conversation";
import { handleDocConversation } from "@/lib/docs/conversation";
import { AnthropicModelClient } from "@/lib/llm";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { loadDocKb, SAMPLE_KB_ID, sampleKbVisible } from "@/lib/server/kbs";
import { kbStore } from "@/lib/store";

let sample: KnowledgeBase | undefined;
let client: AnthropicModelClient | undefined;

// Streams newline-delimited JSON: {"progress": ..., "detail"?: ...} lines while the server
// works (real stages: before and after each model call and each search), then one
// {"result": ...} line, or {"error": ...}. The body names the knowledge base (kbId).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  client ??= new AnthropicModelClient();
  const raw = (await request.json().catch(() => null)) as { kbId?: unknown; events?: unknown; input?: unknown } | null;
  const kbId = typeof raw?.kbId === "string" ? raw.kbId : "";
  const body = raw && { events: raw.events, input: raw.input };
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: object) => controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      try {
        if (kbId === SAMPLE_KB_ID && sampleKbVisible()) {
          sample ??= loadKnowledgeBase();
          send({ result: await handleConversation(sample, client!, body, (p) => send({ progress: p })) });
        } else {
          const kb = await loadDocKb(kbId);
          if (!kb) throw new BadRequest("unknown knowledge base");
          const result = await handleDocConversation(kb, client!, body, (p) => send({ progress: p.stage, detail: p.detail }));
          // A new turn was added: count it for the implementer's usage overview.
          const before = Array.isArray(body?.events) ? body.events.length : 0;
          if (result.events.length > before) await kbStore().recordUsage(kbId, result.events.at(-1)!.result.kind).catch(() => {});
          send({ result });
        }
      } catch (e) {
        if (!(e instanceof BadRequest)) console.error("[conversation]", e);
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
