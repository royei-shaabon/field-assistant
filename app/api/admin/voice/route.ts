import { envStore } from "@/lib/server/env";
import { defaultVoices, VOICE_NAME, voiceService } from "@/lib/voice/tts";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

// The Hebrew voices the account can use, and the one the assistant speaks with.
export async function GET() {
  if (!(await isAdmin())) return forbidden();
  const service = voiceService();
  const current = (await (await envStore()).getSettings()).voice ?? (service ? defaultVoices(service)[0] : "");
  if (!service) return Response.json({ enabled: false, current, voices: [] }, { headers: { "Cache-Control": "no-store" } });
  try {
    // Gemini's text-to-speech voices are left out: that service does not answer here. The live
    // call's Gemini voices are chosen separately (/api/admin/voice/live).
    const voices = (await service.voices()).filter((v) => v.provider !== "gemini");
    return Response.json({ enabled: true, current, voices }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // The provider's message, never a credential: it tells the implementer what to fix.
    return Response.json({ enabled: true, current, voices: [], error: (e as Error).message.slice(0, 400) }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function PUT(request: Request) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`voice:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { voice?: unknown } | null;
  if (typeof body?.voice !== "string" || !VOICE_NAME.test(body.voice)) return Response.json({ error: "voice" }, { status: 400 });
  const store = await envStore();
  await store.putSettings({ ...(await store.getSettings()), voice: body.voice });
  return Response.json({ current: body.voice });
}
