// The assistant's voice in a call: text to natural Hebrew speech, from Google Cloud
// Text-to-Speech with the service's own identity (no key). Without VOICE=google the phone's
// built-in voice is used, as before.
import { googleAccessToken } from "../server/google-auth";

export type VoiceInfo = { name: string; gender: string };

export interface VoiceService {
  // MP3 audio of the text in the given voice.
  synthesize(text: string, voice: string): Promise<Buffer>;
  // The Hebrew voices the account can use.
  voices(): Promise<VoiceInfo[]>;
}

// What is spoken in one request. A step of an answer is far shorter.
export const MAX_SPOKEN_CHARS = 600;

const API = "https://texttospeech.googleapis.com/v1";
// Used until the implementer picks a voice in /admin. If the account does not have it, the
// second one is tried.
export const DEFAULT_VOICES = [process.env.TTS_VOICE || "he-IL-Chirp3-HD-Kore", "he-IL-Wavenet-A"];

async function call(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await googleAccessToken()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw Object.assign(new Error(`speech HTTP ${res.status}: ${body?.error?.message ?? ""}`.slice(0, 400)), { status: res.status });
  return body;
}

export class GoogleVoice implements VoiceService {
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const body = (await call("text:synthesize", {
      method: "POST",
      body: JSON.stringify({ input: { text: text.slice(0, MAX_SPOKEN_CHARS) }, voice: { languageCode: "he-IL", name: voice }, audioConfig: { audioEncoding: "MP3" } }),
    })) as { audioContent?: string };
    if (!body.audioContent) throw new Error("speech: unexpected response");
    return Buffer.from(body.audioContent, "base64");
  }

  async voices(): Promise<VoiceInfo[]> {
    const body = (await call("voices?languageCode=he-IL", { method: "GET" })) as { voices?: { name: string; ssmlGender?: string }[] };
    return (body.voices ?? []).map((v) => ({ name: v.name, gender: v.ssmlGender ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

// Speaks with the chosen voice; when the account refuses that voice, with the next default.
export async function speak(service: VoiceService, text: string, chosen?: string): Promise<{ audio: Buffer; voice: string }> {
  const candidates = [...new Set([...(chosen ? [chosen] : []), ...DEFAULT_VOICES])];
  let last: unknown;
  for (const voice of candidates) {
    try {
      return { audio: await service.synthesize(text, voice), voice };
    } catch (e) {
      last = e;
      // Only "no such voice" style refusals move on to the next voice.
      if ((e as { status?: number }).status !== 400 && (e as { status?: number }).status !== 404) throw e;
    }
  }
  throw last;
}

let shared: VoiceService | null | undefined;

// VOICE=google turns the natural voice on. Anything else: the phone's own voice.
export function voiceService(): VoiceService | null {
  if (shared === undefined) shared = process.env.VOICE === "google" ? new GoogleVoice() : null;
  return shared;
}
