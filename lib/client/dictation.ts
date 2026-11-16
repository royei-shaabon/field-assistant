// Dictation into the message box: the technician talks, the phone's own speech recognition
// writes the words, and the technician sends them (or fixes them first). Nothing is recorded
// or uploaded by us; the recognition belongs to the browser.

type Result = { 0: { transcript: string }; isFinal: boolean };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function recognitionClass(): (new () => Recognition) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canDictate = () => Boolean(recognitionClass());

// Starts listening. `onText` gets everything heard so far (it grows while the technician talks).
// Returns a function that stops listening, or null when the phone cannot dictate.
export function startDictation(events: { onText: (text: string) => void; onEnd: () => void; onBlocked: () => void }): (() => void) | null {
  const R = recognitionClass();
  if (!R) return null;
  const r = new R();
  r.lang = "he-IL";
  r.interimResults = true;
  r.continuous = true;
  // Finished sentences are kept; the one being said is added on top.
  let done = "";
  r.onresult = (e) => {
    let now = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) done += e.results[i][0].transcript;
      else now += e.results[i][0].transcript;
    }
    events.onText((done + now).trim());
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") events.onBlocked();
  };
  r.onend = () => events.onEnd();
  try {
    r.start();
  } catch {
    return null;
  }
  return () => {
    try {
      r.stop();
    } catch {
      // already stopped
    }
  };
}
