import { span } from "@/lib/server/log";
import { envStore } from "@/lib/server/env";
import { embedder } from "@/lib/docs/embed";
import { indexDoc } from "@/lib/docs/semantic";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { Invalid, NotFound } from "@/lib/store";

// Builds (or continues) the meaning index of one document. Each call works for a bounded time
// and reports how far it got; the implementer's screen calls again until the document is done.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`index:${clientKey(request)}`, LIMITS.index)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too_large" }, { status: 413 });
  const using = embedder();
  if (!using) return Response.json({ error: "embeddings_off" }, { status: 409 });
  const { kbId, docId } = await params;
  try {
    const timing = { load: 0, embed: 0, store: 0, batches: 0, sections: 0 };
    const stage = span("index.step", { kb: kbId, doc: docId, model: using.model });
    const progress = await indexDoc(await envStore(), using, kbId, docId, 45_000, timing).catch((e) => {
      stage.fail(e, { batches: timing.batches, sections: timing.sections });
      throw e;
    });
    stage.add("load", timing.load);
    stage.add("embed", timing.embed);
    stage.add("store", timing.store);
    // msPerSection: what one section costs to embed, the number that sizes a big manual.
    stage.end({ ...progress, batches: timing.batches, sections: timing.sections, msPerSection: timing.sections ? Math.round(timing.embed / timing.sections) : 0 });
    return Response.json(progress, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    if (e instanceof Invalid) return Response.json({ error: e.message }, { status: 400 });
    // The provider's message, never a credential: it tells the implementer what to fix.
    return Response.json({ error: "embeddings_failed", detail: (e as Error).message.slice(0, 400) }, { status: 502 });
  }
}
