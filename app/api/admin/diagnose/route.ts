import Anthropic from "@anthropic-ai/sdk";
import { askDocuments } from "@/lib/docs/ask";
import { embedder } from "@/lib/docs/embed";
import { createLiveToken, liveSetup, LIVE_MODEL } from "@/lib/voice/live";
import { SearchIndex } from "@/lib/docs/search";
import { AnthropicModelClient, MODEL } from "@/lib/llm";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";

type Check = { name: string; ok: boolean; ms: number; detail?: string };

// Never includes the key: an API error carries the status and the provider's message only.
function describe(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `HTTP ${e.status ?? "?"}: ${e.message}`.slice(0, 500);
  return (e as Error).message?.slice(0, 500) ?? "unknown error";
}

async function timed(name: string, run: () => Promise<string | undefined>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, detail: describe(e) };
  }
}

// Checks the connection to the model in two steps, so the implementer sees what exactly fails:
// the key and the model, then the full question-answering request on a one-page sample.
export async function POST() {
  if (!(await isAdmin())) return forbidden();
  const checks: Check[] = [];
  const client = new Anthropic({ timeout: 60_000, maxRetries: 0 });

  checks.push(
    await timed("key_and_model", async () => {
      const r = await client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply with: OK" }] });
      return `${r.model}, stop: ${r.stop_reason}`;
    }),
  );

  if (checks[0].ok) {
    checks.push(
      await timed("question_answering", async () => {
        const index = new SearchIndex([
          {
            meta: { id: "diag", kbId: "diag", name: "Connection check", origin: "customer", unit: "page", mime: "text/plain", ext: ".txt", bytes: 0, passages: 1, empty: 0, chars: 0, uploadedAt: "" },
            passages: [{ n: 1, text: "Connection check page. The reset button is on the left side of the control panel. Press and hold it for three seconds." }],
          },
        ]);
        const run = await askDocuments(new AnthropicModelClient(client), index, { kbName: "Connection check", docs: [], question: "איפה כפתור האיפוס?", images: [], history: [] });
        if (run.errors.length) throw new Error(run.errors.join("; "));
        return `result: ${run.result.kind}, searches: ${run.searches.length}`;
      }),
    );
  }
  if (checks[0].ok) {
    // The first search falls back silently when it fails, so this is the only place it shows.
    checks.push(
      await timed("fast_search", async () => {
        const r = await new AnthropicModelClient(client).complete({
          system: "Return two short English search queries for the question.",
          content: [{ type: "text", text: "איפה כפתור האיפוס?" }],
          schema: { type: "object", additionalProperties: false, required: ["queries"], properties: { queries: { type: "array", items: { type: "string" } } } },
          fast: true,
        });
        if (r.text === null) throw new Error(`no output (stop_reason: ${r.stopReason})`);
        return r.text.slice(0, 120);
      }),
    );
  }
  // Search by meaning: only when it is switched on. A Hebrew question and an English sentence
  // with the same meaning should come out close.
  const using = embedder();
  if (using) {
    checks.push(
      await timed("embeddings", async () => {
        const [doc] = await using.embed(["The reset button is on the left side of the control panel."], "document");
        const [same, other] = await using.embed(["איפה כפתור האיפוס?", "מה מזג האוויר מחר?"], "query");
        const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i], 0);
        return `${using.model}, ${doc.length} dims, related ${dot(doc, same).toFixed(2)} vs unrelated ${dot(doc, other).toFixed(2)}`;
      }),
    );
  }
  // The live call: only when GEMINI_API_KEY is set. A token is created and not used.
  if (process.env.GEMINI_API_KEY) {
    checks.push(await timed("live_call", async () => {
      await createLiveToken(process.env.GEMINI_API_KEY!, liveSetup("Connection check"));
      return `${LIVE_MODEL()}: token issued`;
    }));
  }
  return Response.json({ model: MODEL, checks }, { headers: { "Cache-Control": "no-store" } });
}
