// The live call: the technician's phone talks straight to a Gemini Live model (audio in, audio
// out), so the conversation sounds like a person on the line. The server never sees the audio.
// It hands the phone a short-lived token locked to this setup, so the API key stays here and
// the instructions and the one tool cannot be changed from the phone.
//
// Facts about the machine still come from the verified answer engine: the model's only tool,
// answer_from_manual, runs the same /api/conversation pipeline as the chat (every step checked
// against its page), and the verified answer lands in the chat with its sources. The model is
// told to say only what the tool returns. Unlike the chat, the code cannot stop a spoken word
// that breaks this rule; the chat keeps the verified version.

export const LIVE_MODEL = () => process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";

export const LIVE_TOOL = "answer_from_manual";

export function liveInstructions(machine: string): string {
  return [
    `You are the voice of a field assistant for the machine "${machine}". A field technician is talking to you on the phone, in Hebrew, standing next to the machine.`,
    "Speak like an experienced, calm colleague on a call: short spoken sentences in everyday modern Israeli Hebrew, always the plural imperative (\"בדקו\", \"פתחו\"). Never read lists, page numbers, or English terms in brackets.",
    `Everything you say about the machine comes from the tool ${LIVE_TOOL}. For every question about the machine (a fault, a check, a value, a part, a procedure, something in the picture), call it with the technician's question in Hebrew, completed from the conversation so it stands on its own. Then tell the technician what it returned, in your own spoken words:`,
    "- a warning first, if there is one;",
    "- then the steps, in their order, keeping every number, unit and part name exactly as given;",
    "- suggested checks only after saying plainly that they are not from the manual;",
    "- if it found nothing, say the manual you have does not cover it; if it returns a question, ask it.",
    "Never give a technical instruction, a value or a diagnosis from your own knowledge, even when you think you know it.",
    "When there are several steps, say the first two or three, then ask whether to go on.",
    "While the tool is working, stay quiet, or say one short natural word if the pause gets long. Do not announce that you are searching or reading.",
    "Without the tool: greetings, repeating what you said, saying it slower, confirming the technician understood.",
    "If you can see the camera, you may say where something is in the picture, but instructions still come only from the tool.",
    "When you receive the text START, greet in one short sentence and ask what the problem is.",
  ].join("\n");
}

export function liveSetup(machine: string): Record<string, unknown> {
  const voice = process.env.GEMINI_LIVE_VOICE;
  return {
    model: `models/${LIVE_MODEL()}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
    },
    systemInstruction: { parts: [{ text: liveInstructions(machine) }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: LIVE_TOOL,
            description: "Looks up the technician's question in the machine's manuals and returns only what they say, each step checked against its page.",
            // The model keeps talking while the lookup runs, and speaks the result when it is free.
            behavior: "NON_BLOCKING",
            parameters: {
              type: "OBJECT",
              properties: { question: { type: "STRING", description: "The technician's question in Hebrew, complete on its own." } },
              required: ["question"],
            },
          },
        ],
      },
    ],
    inputAudioTranscription: {},
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
