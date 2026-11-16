// The assistant's voice in a call: text to natural Hebrew speech. Up to three providers, each
// on only when configured, so the implementer can compare them by ear in /admin:
// - Google Cloud Text-to-Speech (VOICE=google): the service's own identity, no key. Two kinds
//   of voice: the classic ones ("he-IL-Chirp3-HD-..."), and Gemini voices ("gemini:Kore"), built
//   on a language model, which read a Hebrew word from the sentence around it.
// - Microsoft Azure Speech (AZURE_SPEECH_KEY and AZURE_SPEECH_REGION).
// - ElevenLabs (ELEVENLABS_API_KEY; ELEVENLABS_MODEL picks the model).
// A voice is named "<provider>:<voice>" ("azure:he-IL-HilaNeural"); a bare name is Google's.
// With none configured the phone's built-in voice is used, as before.
import { googleAccessToken } from "../server/google-auth";

export type VoiceInfo = { name: string; gender: string; provider: string };

// A voice name as it may travel in a request and be stored: provider, colon, the provider's id.
export const VOICE_NAME = /^[A-Za-z0-9:_-]{1,100}$/;

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

// A provider refused the voice, or is not configured: the next voice is tried.
const unknownVoice = (message: string) => Object.assign(new Error(message), { status: 404 });

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
    return (body.voices ?? []).map((v) => ({ name: v.name, gender: v.ssmlGender ?? "", provider: "google" })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

// Gemini voices, through the same Google Cloud Text-to-Speech service and identity. The voice
// names are the model's own; any of them speaks any language the model supports.
export const GEMINI_VOICES = ["Kore", "Charon", "Aoede", "Puck", "Leda", "Orus", "Fenrir", "Zephyr"];
// How the line is to be said. Delivery only: what is said is the text.
const GEMINI_STYLE = "Read this aloud in clear, natural modern Israeli Hebrew, at a calm working pace, like a colleague explaining a step.";

export class GeminiVoice implements VoiceService {
  constructor(private model = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-tts") {}
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const body = (await call("text:synthesize", {
      method: "POST",
      body: JSON.stringify({
        input: { text: text.slice(0, MAX_SPOKEN_CHARS), prompt: GEMINI_STYLE },
        voice: { languageCode: "he-IL", name: voice, modelName: this.model },
        audioConfig: { audioEncoding: "MP3" },
      }),
    })) as { audioContent?: string };
    if (!body.audioContent) throw new Error("speech: unexpected response");
    return Buffer.from(body.audioContent, "base64");
  }
  async voices(): Promise<VoiceInfo[]> {
    return GEMINI_VOICES.map((name) => ({ name, gender: this.model, provider: "gemini" }));
  }
}

const escapeXml = (t: string) => t.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

async function provider(url: string, init: RequestInit, label: string): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (res.ok) return res;
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  throw Object.assign(new Error(`${label} HTTP ${res.status}: ${detail}`.slice(0, 400)), { status: res.status });
}

// Microsoft Azure Speech: neural Hebrew voices, by SSML over REST.
export class AzureVoice implements VoiceService {
  constructor(private key: string, private region: string) {}
  private base() {
    return `https://${this.region}.tts.speech.microsoft.com/cognitiveservices`;
  }
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const ssml = `<speak version="1.0" xml:lang="he-IL"><voice name="${escapeXml(voice)}">${escapeXml(text.slice(0, MAX_SPOKEN_CHARS))}</voice></speak>`;
    const res = await provider(`${this.base()}/v1`, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": this.key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "field-assistant" }, body: ssml }, "azure speech");
    return Buffer.from(await res.arrayBuffer());
  }
  async voices(): Promise<VoiceInfo[]> {
    const res = await provider(`${this.base()}/voices/list`, { headers: { "Ocp-Apim-Subscription-Key": this.key } }, "azure speech");
    const list = (await res.json()) as { ShortName: string; Locale: string; Gender?: string }[];
    return list.filter((v) => v.Locale === "he-IL").map((v) => ({ name: v.ShortName, gender: v.Gender ?? "", provider: "azure" }));
  }
}

// ElevenLabs: its multilingual voices speak any language the model supports; which model reads
// Hebrew is set by ELEVENLABS_MODEL.
export class ElevenVoice implements VoiceService {
  constructor(private key: string, private model: string) {}
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const res = await provider(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": this.key, "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, MAX_SPOKEN_CHARS), model_id: this.model, language_code: "he" }) }, "elevenlabs");
    return Buffer.from(await res.arrayBuffer());
  }
  async voices(): Promise<VoiceInfo[]> {
    const res = await provider("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": this.key } }, "elevenlabs");
    const body = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: { gender?: string } }[] };
    return (body.voices ?? []).map((v) => ({ name: v.voice_id, gender: `${v.name}${v.labels?.gender ? ` · ${v.labels.gender}` : ""}`, provider: "eleven" }));
  }
}

// All the configured providers behind one service. A voice name says which provider it is for.
export class VoiceProviders implements VoiceService {
  constructor(private providers: Record<string, VoiceService>) {}
  get names(): string[] {
    return Object.keys(this.providers);
  }
  private route(voice: string): { service: VoiceService; id: string } {
    const at = voice.indexOf(":");
    const [name, id] = at > 0 ? [voice.slice(0, at), voice.slice(at + 1)] : ["google", voice];
    const service = this.providers[name];
    if (!service) throw unknownVoice(`voice provider ${name} is not configured`);
    return { service, id };
  }
  synthesize(text: string, voice: string): Promise<Buffer> {
    const { service, id } = this.route(voice);
    return service.synthesize(text, id);
  }
  // Each provider's voices; one failing provider does not hide the others.
  async voices(): Promise<VoiceInfo[]> {
    const lists = await Promise.all(
      Object.entries(this.providers).map(async ([name, service]) => {
        const list = await service.voices().catch((e: Error) => [{ name: "", gender: e.message.slice(0, 300), provider: `${name}-error` }]);
        return list.map((v) => (v.name && name !== "google" ? { ...v, name: `${name}:${v.name}` } : v));
      }),
    );
    return lists.flat();
  }
}

// Speaks with the chosen voice; when the account refuses that voice, with the next default.
export async function speak(service: VoiceService, text: string, chosen?: string, defaults: string[] = DEFAULT_VOICES): Promise<{ audio: Buffer; voice: string }> {
  const candidates = [...new Set([...(chosen ? [chosen] : []), ...defaults])];
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

let shared: VoiceProviders | null | undefined;

// The configured providers, or null when none is: then the phone speaks with its own voice.
export function voiceService(): VoiceProviders | null {
  if (shared === undefined) {
    const providers: Record<string, VoiceService> = {};
    if (process.env.VOICE === "google") {
      providers.gemini = new GeminiVoice();
      providers.google = new GoogleVoice();
    }
    if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) providers.azure = new AzureVoice(process.env.AZURE_SPEECH_KEY, process.env.AZURE_SPEECH_REGION);
    if (process.env.ELEVENLABS_API_KEY) providers.eleven = new ElevenVoice(process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_MODEL || "eleven_v3");
    shared = Object.keys(providers).length ? new VoiceProviders(providers) : null;
  }
  return shared;
}

// The voices tried when none was chosen, or the chosen one fails: Google's defaults if Google
// is on, then each other provider's default.
export function defaultVoices(service: VoiceProviders): string[] {
  return [
    ...(service.names.includes("gemini") ? [`gemini:${process.env.GEMINI_TTS_VOICE || "Kore"}`] : []),
    ...(service.names.includes("google") ? DEFAULT_VOICES : []),
    ...(service.names.includes("azure") ? [`azure:${process.env.AZURE_VOICE || "he-IL-HilaNeural"}`] : []),
    ...(process.env.ELEVENLABS_VOICE && service.names.includes("eleven") ? [`eleven:${process.env.ELEVENLABS_VOICE}`] : []),
  ];
}
