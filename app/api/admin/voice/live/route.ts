import { log } from "@/lib/server/log";
import { envStore } from "@/lib/server/env";
import { createHash } from "node:crypto";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { isLiveLanguage, isLiveVoice, LIVE_LANGUAGES, LIVE_VOICES, liveLanguage, liveSample, liveVoice } from "@/lib/voice/live";

// The live call's voices: the list, the one in use, and a spoken sample of each.
export async function GET() {
  if (!(await isAdmin())) return forbidden();
  const settings = await (await envStore()).getSettings();
  const languages = Object.entries(LIVE_LANGUAGES).map(([code, l]) => ({ code, name: l.native }));
  return Response.json({ enabled: Boolean(process.env.GEMINI_API_KEY), current: liveVoice(settings.liveVoice), voices: LIVE_VOICES, language: liveLanguage(settings.language), languages }, { headers: { "Cache-Control": "no-store" } });
}

// Chooses the voice, or the language of this environment's calls.
export async function PUT(request: Request) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`voice:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { voice?: unknown; language?: unknown } | null;
  const voice = isLiveVoice(body?.voice) ? body.voice : undefined;
  const language = isLiveLanguage(body?.language) ? body.language : undefined;
  if (!voice && !language) return Response.json({ error: "voice" }, { status: 400 });
  const store = await envStore();
  const settings = await store.getSettings();
  await store.putSettings({ ...settings, ...(voice ? { liveVoice: voice } : {}), ...(language ? { language } : {}) });
  return Response.json({ current: voice ?? liveVoice(settings.liveVoice), language: language ?? liveLanguage(settings.language) });
}

// A sample: the live model says the sentence in that voice. Kept, so each voice and sentence is made once.
export async function POST(request: Request) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`sample:${clientKey(request)}`, LIMITS.speak)) return tooMany();
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "live_off" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { voice?: unknown; text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 300) : "";
  if (!isLiveVoice(body?.voice) || !text) return Response.json({ error: "voice" }, { status: 400 });
  const store = await envStore();
  // Stored beside the classic call's lines (the file is WAV, whatever the store names it).
  const cacheVoice = `live:${body.voice}`;
  const hash = createHash("sha256").update(text).digest("hex");
  const headers = { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=86400" };
  const kept = await store.getAudio(cacheVoice, hash);
  if (kept) return new Response(new Uint8Array(kept), { headers });
  try {
    const wav = await liveSample(key, body.voice, text);
    await store.putAudio(cacheVoice, hash, wav).catch(() => {});
    return new Response(new Uint8Array(wav), { headers });
  } catch (e) {
    log.error("live.sample_failed", e, { voice: body.voice });
    // The provider's message, never the key.
    return Response.json({ error: "sample_failed", detail: (e as Error).message.slice(0, 300) }, { status: 502 });
  }
}
