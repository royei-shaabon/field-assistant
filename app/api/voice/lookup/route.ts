import { embedder } from "@/lib/docs/embed";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { loadDocKb } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { liveLookup } from "@/lib/voice/lookup";

// The live call's tool: a fast search over the machine's documents (lib/voice/lookup.ts).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`lookup:${clientKey(request)}`, LIMITS.lookup)) return tooMany();
  if (tooLarge(request, 4000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 500) : "";
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  if (!kb) return Response.json({ error: "unknown knowledge base" }, { status: 400 });
  if (!question) return Response.json({ error: "no question" }, { status: 400 });
  const started = Date.now();
  const result = await liveLookup(kb.index, question, embedder());
  console.log(`[lookup] ${Date.now() - started}ms, ${result.passages.length} passages`);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
