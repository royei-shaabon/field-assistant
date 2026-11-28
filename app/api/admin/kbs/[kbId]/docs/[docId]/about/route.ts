import { draftAbout } from "@/lib/docs/describe";
import { AnthropicModelClient } from "@/lib/llm";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { span } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

let client: AnthropicModelClient | undefined;

// A draft of the document's description, for the implementer to read and save. Nothing is stored here.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`describe:${clientKey(request)}`, LIMITS.describe)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const { kbId, docId } = await params;
  const stage = span("describe", { env: await currentEnvId(), kb: kbId, doc: docId });
  try {
    const store = await envStore();
    const [kb, doc] = await Promise.all([store.getKb(kbId), store.getPassages(kbId, docId)]);
    stage.part("load");
    if (!kb || !doc) {
      stage.end({ outcome: "not_found" });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    client ??= new AnthropicModelClient();
    const draft = await draftAbout(client, { name: doc.name, machine: kb.name }, doc.passages);
    stage.part("model");
    stage.end({ outcome: draft ? "drafted" : "none", years: Boolean(draft?.years) });
    return draft ? Response.json({ draft }) : Response.json({ error: "no_draft" }, { status: 502 });
  } catch (e) {
    stage.fail(e);
    return Response.json({ error: "no_draft" }, { status: 502 });
  }
}
