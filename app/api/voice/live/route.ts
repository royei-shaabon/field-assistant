import { currentEnvId, envStore } from "@/lib/server/env";
import { log, span } from "@/lib/server/log";
import { activity } from "@/lib/store";
import { createLiveToken, liveLanguage, liveSetup, liveSocketUrl, LIVE_MODEL } from "@/lib/voice/live";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { isAdmin } from "@/lib/server/admin-auth";
import { loadDocKb } from "@/lib/server/kbs";
import { conversationSoFar, type DocEvent } from "@/lib/docs/conversation";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

// The conversation so far as bounded text. The log comes from the phone: a shape that is not a
// conversation gives no context, and the call starts as a new one.
function earlierOf(events: unknown): string {
  if (!Array.isArray(events) || events.length > 80) return "";
  try {
    const known = events.filter((e): e is DocEvent => {
      const event = e as { type?: unknown; result?: { kind?: unknown }; lines?: unknown };
      return (event?.type === "DOC_TURN" && typeof event.result?.kind === "string") || (event?.type === "CALL_LOG" && Array.isArray(event.lines));
    });
    return conversationSoFar(known, 2500);
  } catch {
    return "";
  }
}

// Starts a live call: a one-use token for the phone to talk to the live model directly.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`live:${clientKey(request)}`, LIMITS.live)) return tooMany();
  // The request carries the conversation so far (text only), so the call can continue it.
  if (tooLarge(request, 400_000)) return Response.json({ error: "too large" }, { status: 413 });
  const key = process.env.GEMINI_API_KEY;
  // Not configured: the phone falls back to the call with the browser's voice.
  if (!key) return Response.json({ error: "live_off" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; video?: unknown; events?: unknown } | null;
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  if (!kb) return Response.json({ error: "unknown knowledge base" }, { status: 400 });
  const envId = await currentEnvId();
  const stage = span("live.token", { env: envId, kb: kb.meta.id, video: body?.video === true });
  try {
    // The voice and the language the implementer chose in /admin.
    const settings = await (await envStore()).getSettings();
    stage.part("settings");
    const language = liveLanguage(settings.language);
    // What the phone sends is only read as text for the model, bounded, and never trusted further.
    const earlier = earlierOf(body?.events);
    const setup = (hints: boolean) => liveSetup(kb.meta.name, settings.liveVoice, body?.video === true, language, hints, earlier);
    // If the model refuses the speech recognition hints, the call still starts, without them.
    const token = await createLiveToken(key, setup(true)).catch((e) => {
      log.warn("live.hints_refused", { env: envId, error: (e as Error).message.slice(0, 200) });
      return createLiveToken(key, setup(false));
    });
    stage.part("token");
    stage.end({ language, voice: settings.liveVoice ?? "default", earlierChars: earlier.length });
    await activity(envId).measure((day) => void day.calls++).catch(() => {});
    return Response.json({ url: liveSocketUrl(token), model: LIVE_MODEL(), language }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    stage.fail(e);
    // The provider's message (never the key) for the implementer; technicians get the fallback.
    return Response.json({ error: "live_failed", ...((await isAdmin()) ? { detail: (e as Error).message } : {}) }, { status: 502 });
  }
}
