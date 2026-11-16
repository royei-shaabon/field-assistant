// The assistant's voice in a call, on the phone. Lines are spoken one after another as they
// arrive; the next line is fetched while the current one plays; and everything can be cut
// short the moment the technician starts to talk.
// The natural voice comes from the server (/api/voice/speak). When the server has none
// configured, or a request fails, the phone's own voice is used for that line.

// A quarter of a second of silence. Playing it inside a tap unlocks the audio element, so the
// phone (iPhone above all) lets it play later lines that arrive after a network wait.
export const SILENCE = "data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

// iPhone and iPad: a second microphone stream while speaking moves the sound to the earpiece and
// competes with speech recognition, so there the assistant is interrupted by a tap only.
export const isIOS = () => typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

type Line = { text: string; url: Promise<string | null> };

class VoicePlayer {
  private audio: HTMLAudioElement | null = null;
  private queue: Line[] = [];
  private playing = false;
  // Grows on every stop, so a line that finishes late knows it was cancelled.
  private generation = 0;
  private cloud = true;
  onState: (speaking: boolean) => void = () => {};

  // Must be called from a tap (starting the call), or phones refuse to play sound later.
  unlock(): void {
    this.audio ??= new Audio();
    this.audio.src = SILENCE;
    void this.audio.play().catch(() => {});
    this.cloud = true;
  }

  private fetchLine(text: string): Promise<string | null> {
    if (!this.cloud) return Promise.resolve(null);
    return fetch("/api/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
      .then(async (res) => {
        // 409: the server has no voice configured. Stop asking for the rest of the call.
        if (res.status === 409) this.cloud = false;
        return res.ok ? URL.createObjectURL(await res.blob()) : null;
      })
      .catch(() => null);
  }

  // Adds lines to what is being said. `replace` drops whatever was still waiting.
  say(lines: string[], replace: boolean): void {
    if (replace) this.stop();
    for (const text of lines) if (text.trim()) this.queue.push({ text, url: this.fetchLine(text) });
    void this.next();
  }

  get speaking(): boolean {
    return this.playing;
  }

  private async next(): Promise<void> {
    if (this.playing) return;
    const line = this.queue.shift();
    if (!line) return this.onState(false);
    const generation = this.generation;
    this.playing = true;
    this.onState(true);
    const url = await line.url;
    if (generation !== this.generation) return void (url && URL.revokeObjectURL(url));
    const done = () => {
      if (url) URL.revokeObjectURL(url);
      if (generation !== this.generation) return;
      this.playing = false;
      void this.next();
    };
    if (url && this.audio) {
      this.audio.onended = done;
      // The phone refused to play the recording: say the line with the phone's own voice instead.
      this.audio.onerror = () => this.phoneVoice(line.text, done);
      this.audio.src = url;
      this.audio.play().catch(() => this.phoneVoice(line.text, done));
      return;
    }
    this.phoneVoice(line.text, done);
  }

  // The phone's own Hebrew voice, if it has one.
  private phoneVoice(text: string, done: () => void): void {
    const synth = window.speechSynthesis;
    if (!synth) return done();
    const u = new SpeechSynthesisUtterance(/[.?!:,]$/.test(text) ? text : `${text}.`);
    u.lang = "he-IL";
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith("he"));
    if (voice) u.voice = voice;
    u.onend = u.onerror = done;
    try {
      synth.speak(u);
    } catch {
      done();
    }
  }

  // Silence, now: the technician started talking, tapped, or hung up.
  stop(): void {
    this.generation++;
    this.queue = [];
    if (this.audio) {
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
    }
    window.speechSynthesis?.cancel();
    if (this.playing) {
      this.playing = false;
      this.onState(false);
    }
  }
}

let shared: VoicePlayer | undefined;
export function voicePlayer(): VoicePlayer {
  return (shared ??= new VoicePlayer());
}

// Listens to the microphone while the assistant talks, and calls back when the technician
// starts to speak over it. The phone's echo cancellation removes the assistant's own voice
// from what the microphone hears; how well depends on the phone. Returns how to stop listening.
export function listenForSpeech(onSpeech: () => void): () => void {
  if (isIOS()) return () => {};
  let stopped = false;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    void context?.close().catch(() => {});
  };
  navigator.mediaDevices
    ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then((s) => {
      if (stopped) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(s).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      // The first moments set the level of the room (and of whatever echo gets through).
      let floor = 0;
      let calibrating = 8;
      let loud = 0;
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const level = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
        if (calibrating > 0) {
          floor = Math.max(floor, level);
          calibrating--;
          return;
        }
        // Speech: clearly above the room, for a quarter of a second in a row.
        loud = level > Math.max(0.05, floor * 4) ? loud + 1 : 0;
        if (loud >= 5) {
          stop();
          onSpeech();
        }
      }, 50);
    })
    .catch(() => {});
  return stop;
}
