import Anthropic from "@anthropic-ai/sdk";
import { askDocuments } from "@/lib/docs/ask";
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
  return Response.json({ model: MODEL, checks }, { headers: { "Cache-Control": "no-store" } });
}
