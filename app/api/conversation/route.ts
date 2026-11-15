import { loadKnowledgeBase, type KnowledgeBase } from "@/lib/kb";
import { BadRequest, handleConversation } from "@/lib/conversation";
import { handleDocConversation } from "@/lib/docs/conversation";
import { embedder } from "@/lib/docs/embed";
import { pageImage } from "@/lib/docs/page-image";
import { AnthropicModelClient } from "@/lib/llm";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { loadDocKb, SAMPLE_KB_ID, sampleKbVisible } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { kbStore } from "@/lib/store";

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
  const raw = (await request.json().catch(() => null)) as { kbId?: unknown; events?: unknown; input?: unknown } | null;
  const kbId = typeof raw?.kbId === "string" ? raw.kbId : "";
  // Looking at a saved conversation is free; anything else may call the model.
  const asks = (raw?.input as { kind?: unknown } | undefined)?.kind !== "view";
  if (asks && (!allow(`ask:${clientKey(request)}`, LIMITS.ask) || !allow("ask:all", LIMITS.askDaily))) return tooMany();
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
          const result = await handleDocConversation(kb, client!, body, (p) => send({ progress: p.stage === "reading" ? "pages" : p.stage, detail: p.detail }), request.signal, {
            // Each verified step goes to the phone as soon as it is written.
            onPartial: (partial) => send({ partial }),
            embedder: embedder(),
            pageImage: async (hit) => {
              const image = await pageImage(kbId, hit.docId, hit.n);
              return image && { data: image.png.toString("base64"), mediaType: "image/png" as const, width: image.width, height: image.height };
            },
          });
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
