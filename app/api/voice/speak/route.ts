import { createHash } from "node:crypto";
import { defaultVoices, MAX_SPOKEN_CHARS, speak, VOICE_NAME, voiceService } from "@/lib/voice/tts";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { isAdmin } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { kbStore } from "@/lib/store";

// One spoken line of a call: text in, MP3 out. The same line in the same voice is synthesised
// once and then served from the store.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`speak:${clientKey(request)}`, LIMITS.speak)) return tooMany();
  if (tooLarge(request, 8000)) return Response.json({ error: "too large" }, { status: 413 });
  const service = voiceService();
  // Not configured: the phone speaks with its own voice.
  if (!service) return Response.json({ error: "voice_off" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { text?: unknown; voice?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_SPOKEN_CHARS) : "";
  if (!text) return Response.json({ error: "text" }, { status: 400 });
  const store = kbStore();
  // Trying another voice is for the implementer's voice picker only.
  const override = typeof body?.voice === "string" && VOICE_NAME.test(body.voice) && (await isAdmin()) ? body.voice : undefined;
  const chosen = override ?? (await store.getSettings()).voice;
  const hash = createHash("sha256").update(text).digest("hex");
  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" };
  try {
    const cached = chosen ? await store.getAudio(chosen, hash) : null;
    if (cached) return new Response(new Uint8Array(cached), { headers });
    const { audio, voice } = await speak(service, text, chosen, defaultVoices(service));
    await store.putAudio(voice, hash, audio).catch(() => {});
    return new Response(new Uint8Array(audio), { headers });
  } catch (e) {
    console.error("[speak]", (e as Error).message);
    return Response.json({ error: "voice_failed" }, { status: 502 });
  }
}
