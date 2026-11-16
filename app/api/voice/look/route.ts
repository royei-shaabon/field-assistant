import { AnthropicModelClient } from "@/lib/llm";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnvId, envStore } from "@/lib/server/env";
import { LIVE_LANGUAGES, liveLanguage } from "@/lib/voice/live";
import { loadDocKb } from "@/lib/server/kbs";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { activity } from "@/lib/store";
import { liveLookup } from "@/lib/voice/lookup";
import { lookAtPicture } from "@/lib/voice/look";

let client: AnthropicModelClient | undefined;

// The video call's eyes: finds a named part in the picture the phone sends, or the part a
// finger points at, or answers a question about what the picture shows (lib/voice/look.ts).
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`look:${clientKey(request)}`, LIMITS.look)) return tooMany();
  if (tooLarge(request, 2_500_000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; image?: unknown; find?: unknown; pointing?: unknown; question?: unknown; ring?: unknown } | null;
  const image = typeof body?.image === "string" ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.image) : null;
  const find = typeof body?.find === "string" ? body.find.trim().slice(0, 80) : "";
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, 300) : "";
  const pointing = body?.pointing === true;
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  if (!kb) return Response.json({ error: "unknown knowledge base" }, { status: 400 });
  if (!image || (!find && !question && !pointing)) return Response.json({ error: "bad request" }, { status: 400 });
  const envId = await currentEnvId();
  const started = Date.now();
  const mode = pointing ? "pointing" : find ? "find" : "question";
  try {
    client ??= new AnthropicModelClient();
    // A question about the picture gets the manual's own words for what may be in it (which
    // indicator is which). By keywords only: no waiting for the meaning search here.
    const passages = question ? (await liveLookup(kb.index, question, null)).passages.slice(0, 3) : undefined;
    const language = LIVE_LANGUAGES[liveLanguage((await (await envStore()).getSettings()).language)].name;
    const look = await lookAtPicture(client, { image: { mediaType: image[1] as "image/jpeg", data: image[2] }, find: find || undefined, pointing, question: question || undefined, ring: body?.ring === true, language, passages });
    const ms = Date.now() - started;
    log.info("live.look", { env: envId, kb: kb.meta.id, mode, ms, visible: look.visible, quality: look.quality });
    if (ms > 6000) log.warn("live.look_slow", { env: envId, kb: kb.meta.id, ms });
    await activity(envId)
      .measure((day) => ((day.looks = (day.looks ?? 0) + 1), void (day.lookMs = (day.lookMs ?? 0) + ms)))
      .catch(() => {});
    return Response.json(look, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("live.look_failed", e, { env: envId, kb: kb.meta.id, mode, ms: Date.now() - started });
    return Response.json({ error: "look_failed" }, { status: 502 });
  }
}
