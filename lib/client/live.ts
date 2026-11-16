// The live call on the phone: microphone to the live model, the model's voice to the speaker,
// over one WebSocket. The model hears the technician talk over it and stops by itself (the
// server tells us, and the queued sound is dropped). Tool calls are answered by the app.

let shared: AudioContext | undefined;

// Must run inside the tap that starts the call, or a phone keeps the sound off.
export function primeLiveAudio(): AudioContext | undefined {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return undefined;
    shared ??= new Ctx();
    void shared.resume().catch(() => {});
    return shared;
  } catch {
    return undefined;
  }
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// The microphone, as 16 kHz 16-bit PCM in ~100 ms pieces. The worklet copies what it hears to
// the page; the page brings it down to 16 kHz.
const WORKLET = `class Tap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } } registerProcessor("tap", Tap);`;

// How loud a 100 ms piece of the microphone must be (RMS, 0..1) to count as the technician
// talking over the model rather than the model's own voice from the speaker.
const BARGE_IN = 0.05;

// A tool of the video call other than the manual lookup: marking a part or looking at the
// picture. The app answers it; `quiet` means the model need not say anything about the result.
export type VideoTool = { name: string; args: Record<string, unknown> };
export type VideoToolResult = { result: unknown; quiet: boolean };

const ANSWER_TOOL = "answer_from_manual";

export type LiveEvents = {
  onState: (s: "connecting" | "listening" | "speaking" | "ended") => void;
  onHeard: (text: string) => void; // the technician, as transcribed
  onSaid: (text: string, fresh: boolean) => void; // the model, as transcribed
  // `english`: the same question in English, when the model gave one.
  onTool: (question: string, english?: string) => Promise<unknown>;
  // Video calls: the model asked to mark a part or to look at the picture.
  onVideoTool?: (tool: VideoTool) => Promise<VideoToolResult>;
  onError: (message: string) => void;
};

export class LiveCall {
  private ws?: WebSocket;
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioNode;
  private sources: AudioBufferSourceNode[] = [];
  private nextTime = 0;
  private pending: number[] = [];
  private muted = false;
  private dropUntilTurn = false;
  private newTurn = true;
  // Until when the microphone is still treated as hearing the speaker (the echo's tail).
  private quietAt = 0;
  private ended = false;
  private frames?: ReturnType<typeof setInterval>;

  constructor(private events: LiveEvents) {}

  async start(url: string, model: string, frame?: () => string | undefined): Promise<void> {
    this.events.onState("connecting");
    this.ctx = primeLiveAudio();
    if (!this.ctx) throw new Error("no audio");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ws = new WebSocket(url);
    // The server sends binary frames. Read them as bytes and decode at once, so the pieces of
    // sound are handled in the order they came (an async Blob read could reorder them).
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket"));
    });
    ws.onclose = (e) => {
      if (!this.ended) this.events.onError(e.reason || `closed ${e.code}`);
      this.stop();
    };
    ws.onmessage = (e) => void this.receive(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
    // The setup itself is locked into the token; the model name is enough here.
    ws.send(JSON.stringify({ setup: { model: `models/${model}` } }));
    await this.startMicrophone();
    // In a video call the model sees the camera, one picture a second.
    if (frame) {
      this.frames = setInterval(() => {
        const f = frame();
        if (f && !this.muted) this.send({ realtimeInput: { video: { mimeType: "image/jpeg", data: f.slice(f.indexOf(",") + 1) } } });
      }, 1000);
    }
  }

  // While the model is talking, the phone's speaker reaches its own microphone, and the model
  // would hear itself and stop. So while it talks (and a moment after), quiet pieces go out as
  // silence. A voice counts only when two pieces in a row (~200 ms) are loud: the technician
  // talking over it, close to the phone. Then everything goes through, the held piece first.
  private held: number[] | null = null;
  private gate(piece: number[]): number[][] {
    const talking = this.sources.length > 0 || this.ctx!.currentTime < this.quietAt;
    if (!talking) {
      this.held = null;
      return [piece];
    }
    const rms = Math.sqrt(piece.reduce((sum, v) => sum + v * v, 0) / piece.length);
    if (rms < BARGE_IN) {
      this.held = null;
      return [new Array<number>(piece.length).fill(0)];
    }
    if (!this.held) {
      this.held = piece;
      return [new Array<number>(piece.length).fill(0)];
    }
    const out = [this.held, piece];
    this.held = null;
    return out;
  }

  private send(message: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private async startMicrophone() {
    const ctx = this.ctx!;
    const source = ctx.createMediaStreamSource(this.stream!);
    const ratio = ctx.sampleRate / 16000;
    const onSamples = (input: Float32Array) => {
      if (this.muted) return;
      // Down to 16 kHz by averaging, then 16-bit.
      for (let i = 0; i + ratio <= input.length; i += ratio) {
        let sum = 0;
        let n = 0;
        for (let j = Math.floor(i); j < Math.floor(i + ratio); j++, n++) sum += input[j];
        this.pending.push(n ? sum / n : 0);
      }
      if (this.pending.length >= 1600) {
        const piece = this.pending;
        this.pending = [];
        for (const out of this.gate(piece)) {
          const pcm = new Int16Array(out.length);
          out.forEach((v, i) => (pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff));
          this.send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: toBase64(new Uint8Array(pcm.buffer)) } } });
        }
      }
    };
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "tap");
      node.port.onmessage = (e) => onSamples(e.data as Float32Array);
      source.connect(node);
      this.node = node;
    } else {
      // Older phones: the deprecated processor still works everywhere.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0));
      source.connect(node);
      node.connect(ctx.destination);
      this.node = node;
    }
    this.events.onState("listening");
  }

  private play(b64: string) {
    const ctx = this.ctx!;
    const bytes = fromBase64(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buffer = ctx.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.nextTime);
    source.start(at);
    this.nextTime = at + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((s) => s !== source);
      this.quietAt = ctx.currentTime + 0.35;
      if (!this.sources.length) this.events.onState("listening");
    };
    this.events.onState("speaking");
  }

  // Silence now: the technician talked over it, or tapped.
  hush() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
    this.nextTime = 0;
    // It stopped because the technician talked: let the microphone through at once.
    this.quietAt = 0;
    this.events.onState("listening");
  }

  // A tap: stop talking, and drop the rest of what it was about to say.
  interrupt() {
    this.dropUntilTurn = true;
    this.hush();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.pending = [];
  }

  private async receive(text: string) {
    let msg: {
      setupComplete?: object;
      serverContent?: { modelTurn?: { parts?: { inlineData?: { data: string } }[] }; interrupted?: boolean; turnComplete?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string } };
      toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
      goAway?: object;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.setupComplete) this.send({ realtimeInput: { text: "START" } });
    const c = msg.serverContent;
    if (c) {
      if (c.interrupted) {
        this.hush();
        this.newTurn = true;
      }
      if (c.inputTranscription?.text) {
        this.events.onHeard(c.inputTranscription.text);
        this.dropUntilTurn = false;
      }
      if (c.outputTranscription?.text && !this.dropUntilTurn) {
        this.events.onSaid(c.outputTranscription.text, this.newTurn);
        this.newTurn = false;
      }
      for (const part of c.modelTurn?.parts ?? []) if (part.inlineData?.data && !this.dropUntilTurn) this.play(part.inlineData.data);
      if (c.turnComplete) {
        this.newTurn = true;
        this.dropUntilTurn = false;
      }
    }
    for (const call of msg.toolCall?.functionCalls ?? []) {
      if (call.name !== ANSWER_TOOL) {
        // Marking or looking: answered by the app while the model keeps listening.
        const answer = (await this.events.onVideoTool?.({ name: call.name, args: (call.args ?? {}) as Record<string, unknown> }).catch(() => null)) ?? { result: { ok: false }, quiet: true };
        this.send({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { result: answer.result, scheduling: answer.quiet ? "SILENT" : "WHEN_IDLE" } }] } });
        continue;
      }
      const asked = (call.args ?? {}) as { question?: unknown; english?: unknown };
      const result = await this.events.onTool(String(asked.question ?? ""), typeof asked.english === "string" ? asked.english : undefined).catch(() => ({ kind: "error" }));
      // Said as soon as the model finishes what it is saying now.
      this.send({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { result, scheduling: "WHEN_IDLE" } }] } });
    }
    if (msg.goAway) this.events.onError("goAway");
  }

  // The technician touched the picture: the model gets the picture with a ring at that spot,
  // and where it is, and is asked (by its instructions) to say what it is and mark it.
  point(x: number, y: number, picture?: string) {
    if (picture) this.send({ realtimeInput: { video: { mimeType: "image/jpeg", data: picture.slice(picture.indexOf(",") + 1) } } });
    this.send({ realtimeInput: { text: `TAP x=${Math.round(x)} y=${Math.round(y)}` } });
  }

  stop() {
    if (this.ended) return;
    this.ended = true;
    if (this.frames) clearInterval(this.frames);
    this.hush();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.events.onState("ended");
  }
}
