// npm run skill-eval [-- identify|interpret] [-- --require-photos]
// Calls the real model. Needs Anthropic credentials (ANTHROPIC_API_KEY or an `ant auth login` profile).
import { loadKnowledgeBase } from "../lib/kb";
import { AnthropicModelClient } from "../lib/llm";
import { evalIdentifyPhotos, evalIdentifyText, evalInterpret, type SetReport } from "../lib/skills/eval";

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"));
const requirePhotos = args.includes("--require-photos");

async function main() {
  const client = new AnthropicModelClient();
  // Skills swallow API errors into a fallback, which would look like a low score. Fail loudly instead.
  try {
    await client.complete({
      system: "Return an empty JSON object.",
      content: [{ type: "text", text: "{}" }],
      schema: { type: "object", additionalProperties: false, properties: {} },
    });
  } catch (e) {
    console.error(`skill-eval: cannot reach the model: ${(e as Error).message}`);
    process.exit(1);
  }
  const reports: SetReport[] = [];
  if (!only || only === "interpret") reports.push(await evalInterpret(client));
  if (!only || only === "identify") {
    reports.push(await evalIdentifyText(client));
    reports.push(await evalIdentifyPhotos(client, loadKnowledgeBase()));
  }

  for (const r of reports) {
    const fallbacks = r.cases.filter((c) => !c.ok).length;
    const latency = r.maxMs !== undefined ? `, max ${r.maxMs}ms (limit ${r.latencyLimitMs}ms)` : "";
    console.log(`\n${r.set}: ${r.status.toUpperCase()} ${r.correct}/${r.total}` +
      ` (need >= ${Math.round(r.required.minRatio * 100)}% of >= ${r.required.minTotal})${latency}` +
      (fallbacks ? `, ${fallbacks} fallback(s)` : ""));
    for (const c of r.cases.filter((c) => !c.correct || !c.ok)) {
      console.log(`  x ${c.name} | expected ${c.expected} | got ${c.got}${c.ok ? "" : " [fallback]"}`);
    }
  }

  const failed = reports.some((r) => r.status === "fail" || (requirePhotos && r.status === "pending"));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
