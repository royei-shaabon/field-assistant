import { currentEnvId, envStore } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { activity } from "@/lib/store";
import { createLiveToken, liveLanguage, liveSetup, liveSocketUrl, LIVE_MODEL } from "@/lib/voice/live";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { isAdmin } from "@/lib/server/admin-auth";
import { loadDocKb } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

// Starts a live call: a one-use token for the phone to talk to the live model directly.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`live:${clientKey(request)}`, LIMITS.live)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const key = process.env.GEMINI_API_KEY;
  // Not configured: the phone falls back to the call with the browser's voice.
  if (!key) return Response.json({ error: "live_off" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; video?: unknown } | null;
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  if (!kb) return Response.json({ error: "unknown knowledge base" }, { status: 400 });
  const envId = await currentEnvId();
  const started = Date.now();
  try {
    // The voice and the language the implementer chose in /admin.
    const settings = await (await envStore()).getSettings();
    const language = liveLanguage(settings.language);
    const setup = (hints: boolean) => liveSetup(kb.meta.name, settings.liveVoice, body?.video === true, language, hints);
    // If the model refuses the speech recognition hints, the call still starts, without them.
    const token = await createLiveToken(key, setup(true)).catch((e) => {
      log.warn("live.hints_refused", { env: envId, error: (e as Error).message.slice(0, 200) });
      return createLiveToken(key, setup(false));
    });
    log.info("live.token", { env: envId, kb: kb.meta.id, language, video: body?.video === true, ms: Date.now() - started });
    await activity(envId).measure((day) => void day.calls++).catch(() => {});
    return Response.json({ url: liveSocketUrl(token), model: LIVE_MODEL(), language }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("live.token_failed", e, { env: envId, kb: kb.meta.id, ms: Date.now() - started });
    // The provider's message (never the key) for the implementer; technicians get the fallback.
    return Response.json({ error: "live_failed", ...((await isAdmin()) ? { detail: (e as Error).message } : {}) }, { status: 502 });
  }
}
