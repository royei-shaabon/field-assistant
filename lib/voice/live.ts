// The live call: the technician's phone talks straight to a Gemini Live model (audio in, audio
// out), so the conversation sounds like a person on the line. The server never sees the audio.
// It hands the phone a short-lived token locked to this setup, so the API key stays here and
// the instructions and the one tool cannot be changed from the phone.
//
// What the model is told is its skills (skills/<name>/SKILL.md), and what it can do is the
// tools those skills name (tools/<name>/tool.json); see lib/skills/registry.ts.
// Facts about the machine come from the machine's documents: the retrieval skill's tool,
// answer_from_manual, is a fast search (lib/voice/lookup.ts, a second or two) that returns the
// passages, and the model says what they say. At the same time the chat runs the full answer
// engine for the same question (every step checked against its page), and that answer lands on
// the screen with its sources. The model is told to say only what the passages say; the code
// cannot stop a spoken word that breaks this rule, and the screen keeps the checked version.

import { agentSkills, agentTools, fill, type Agent } from "../skills/registry";

export const LIVE_MODEL = () => process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";

export const LIVE_TOOL = "answer_from_manual";
// Video calls only: the model points at a part it sees in the camera picture.
export const LIVE_MARK_TOOL = "mark_on_picture";
export const LIVE_LOOK_TOOL = "look_at_picture";

// The voices the implementer can choose for the live call, each with a Hebrew name to pick it
// by. The style words are Google's own descriptions of its voices.
export const LIVE_VOICES = [
  { name: "Orus", label: "אורי", gender: "male", style: "תקיף" },
  { name: "Charon", label: "חנן", gender: "male", style: "מסביר, רגוע" },
  { name: "Algenib", label: "גיל", gender: "male", style: "מחוספס" },
  { name: "Alnilam", label: "אלון", gender: "male", style: "החלטי" },
  { name: "Iapetus", label: "יפתח", gender: "male", style: "צלול" },
  { name: "Schedar", label: "שחר", gender: "male", style: "שקול" },
  { name: "Fenrir", label: "פלג", gender: "male", style: "נמרץ" },
  { name: "Puck", label: "פז", gender: "male", style: "קליל" },
  { name: "Kore", label: "קרן", gender: "female", style: "תקיפה" },
  { name: "Gacrux", label: "גלית", gender: "female", style: "בוגרת" },
  { name: "Sulafat", label: "שולה", gender: "female", style: "חמה" },
  { name: "Aoede", label: "עדי", gender: "female", style: "קלילה" },
] as const;

// A man's firm voice by default: it sounds like an experienced colleague.
export const LIVE_VOICE = "Orus";

export const isLiveVoice = (name: unknown): name is string => typeof name === "string" && LIVE_VOICES.some((v) => v.name === name);

// The voice of the next call: the implementer's choice in /admin, then the environment, then the default.
export const liveVoice = (chosen?: string) => (isLiveVoice(chosen) ? chosen : process.env.GEMINI_LIVE_VOICE || LIVE_VOICE);

// The language of an environment's calls. The implementer chooses it, so the model expects one
// language and does not have to guess it from a noisy first word.
export const LIVE_LANGUAGES = {
  he: { name: "Hebrew", native: "עברית", style: 'everyday modern Israeli Hebrew, always the plural imperative ("בדקו", "פתחו")', example: "הרמתם את הרגלית הצדדית?" },
  en: { name: "English", native: "English", style: "plain everyday English", example: "Did you put the side stand up?" },
  ru: { name: "Russian", native: "Русский", style: "plain everyday Russian, polite plural (вы)", example: "Вы подняли боковую подножку?" },
  ar: { name: "Arabic", native: "العربية", style: "plain everyday spoken Arabic", example: "هل رفعتم المسند الجانبي؟" },
} as const;
export type LiveLanguage = keyof typeof LIVE_LANGUAGES;
export const isLiveLanguage = (code: unknown): code is LiveLanguage => typeof code === "string" && code in LIVE_LANGUAGES;
export const liveLanguage = (chosen?: string): LiveLanguage => (isLiveLanguage(chosen) ? chosen : "he");

// The call agent's brief is its skills, in the order skills/registry.json gives them: each
// skill's document (skills/<name>/SKILL.md) is one chapter. A video call has one more skill,
// the camera, and with it that skill's two tools.
const agentOf = (video: boolean): Agent => (video ? "video" : "call");

export function liveInstructions(machine: string, video = false, language: LiveLanguage = "he"): string {
  const lang = LIVE_LANGUAGES[language];
  const values = { machine, language: lang.name, style: lang.style, example: lang.example };
  return [
    `You are the voice of a field assistant for the machine "${machine}". A field technician is talking to you on the phone, in ${lang.name}, standing next to the machine. Your job is to get their problem solved: understand what is wrong, find what the machine's manual says about it, and walk them through it.`,
    ...agentSkills(agentOf(video)).flatMap((skill) => ["", `# ${skill.title}`, fill(skill.body, values)]),
    "",
    "When you receive the text START, greet in one short sentence and ask what the problem is.",
  ].join("\n");
}

// A tool's JSON Schema in the form the live model takes (upper-case type names).
function liveSchema(schema: unknown, values: Record<string, string>): unknown {
  if (Array.isArray(schema)) return schema.map((item) => liveSchema(item, values));
  if (!schema || typeof schema !== "object") return typeof schema === "string" ? fill(schema, values) : schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === "type" && typeof value === "string" ? value.toUpperCase() : liveSchema(value, values)]));
}

// What the live model is given: the tools its skills name for this kind of call, nothing else.
export function liveTools(video: boolean, language: LiveLanguage = "he"): { name: string; description: string; behavior: string; parameters: unknown }[] {
  const values = { language: LIVE_LANGUAGES[language].name };
  // The model keeps listening while a tool runs, and speaks the result when it is free.
  return agentTools(agentOf(video)).map((tool) => ({ name: tool.name, description: fill(tool.description, values), behavior: "NON_BLOCKING", parameters: liveSchema(tool.input_schema, values) }));
}

// `hints: false` leaves out the speech recognition hints, for a model that refuses them.
export function liveSetup(machine: string, chosenVoice?: string, video = false, language: LiveLanguage = "he", hints = true): Record<string, unknown> {
  const voice = liveVoice(chosenVoice);
  return {
    model: `models/${LIVE_MODEL()}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: { parts: [{ text: liveInstructions(machine, video, language) }] },
    tools: [{ functionDeclarations: liveTools(video, language) }],
    // A phone's speaker reaches its own microphone. Low start sensitivity and a longer run of
    // speech before it counts: the model's own voice coming back must not cut it off.
    realtimeInputConfig: {
      automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", prefixPaddingMs: 200, silenceDurationMs: 500 },
    },
    // What the technician says is recognised as this language, not guessed; the machine's name
    // is a word the recogniser should expect.
    inputAudioTranscription: hints ? { languageCodes: [language], customVocabulary: [machine.slice(0, 60)] } : {},
    outputAudioTranscription: {},
  };
}

const API = "https://generativelanguage.googleapis.com/v1beta";

export const liveSocketUrl = (token: string) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;

// A token good for one call: it must be used within a minute, and the call lasts at most 30.
export async function createLiveToken(apiKey: string, setup: Record<string, unknown>, now = Date.now()): Promise<string> {
  const res = await fetch(`${API}/auth_tokens`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      bidiGenerateContentSetup: setup,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { name?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.name) throw new Error(`live token HTTP ${res.status}: ${body?.error?.message ?? ""}`.slice(0, 400));
  return body.name;
}

// PCM from the live model (24 kHz, 16-bit, mono) as a WAV file any browser plays.
export function pcmToWav(pcm: Buffer, rate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type Socket = { binaryType?: string; send(data: string): void; close(): void; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onerror: (() => void) | null; onclose: ((e: { code?: number; reason?: string }) => void) | null };

// One sentence in one of the live voices, for the implementer to listen to before choosing.
// It is the live model itself saying it, through the same kind of token as a call, so what is
// heard here is what a technician hears. Returns a WAV file.
export async function liveSample(apiKey: string, voice: string, text: string, open: (url: string) => Socket = (url) => new WebSocket(url) as unknown as Socket): Promise<Buffer> {
  const token = await createLiveToken(apiKey, {
    model: `models/${LIVE_MODEL()}`,
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    systemInstruction: { parts: [{ text: "You are a voice sample. Say aloud, in Hebrew, exactly the sentence you receive, once, and nothing else." }] },
  });
  const ws = open(liveSocketUrl(token));
  ws.binaryType = "arraybuffer";
  const chunks: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the live model did not answer in 25 seconds")), 25_000);
      const done = (error?: Error) => (clearTimeout(timer), error ? reject(error) : resolve());
      ws.onopen = () => ws.send(JSON.stringify({ setup: { model: `models/${LIVE_MODEL()}` } }));
      ws.onerror = () => done(new Error("could not connect to the live model"));
      ws.onclose = (e) => done(chunks.length ? undefined : new Error(`the live model closed the connection: ${e.reason || e.code || ""}`.slice(0, 300)));
      ws.onmessage = (e) => {
        const raw = typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8");
        let msg: { setupComplete?: object; serverContent?: { modelTurn?: { parts?: { inlineData?: { data: string } }[] }; turnComplete?: boolean } };
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text } }));
        for (const part of msg.serverContent?.modelTurn?.parts ?? []) if (part.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, "base64"));
        if (msg.serverContent?.turnComplete) done();
      };
    });
  } finally {
    ws.close();
  }
  if (!chunks.length) throw new Error("the live model returned no sound");
  return pcmToWav(Buffer.concat(chunks));
}
