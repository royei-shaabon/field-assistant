"use client";

// Live call with the assistant: the technician talks (browser speech recognition, Hebrew), the
// assistant answers out loud, line by line as the answer is written (lib/client/voice.ts), with
// the same lines the chat shows, and can be cut short by talking over it or by a tap.
// In a video call the camera stays on and a frame goes with every sentence.
// The call is a front end to the same conversation: everything said lands in the chat.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Progress } from "@/lib/conversation";
import type { Screen } from "@/lib/screen";
import { LiveCall, type TraceEvent, type VideoTool, type VideoToolResult } from "@/lib/client/live";
import { locate, LOST, templateAt, toGray, type Gray, type Template } from "@/lib/client/track";
import { listenForSpeech, voicePlayer } from "@/lib/client/voice";
import { forVoice } from "@/lib/speech";
import { T } from "@/lib/ui-text";
import type { DocMark } from "@/lib/docs/ask";
import { MarkedImage, StopCard } from "./Chat";
import { DocHazard, MarksLegend } from "./DocChat";
import { LogoMark } from "./Logo";
import { ApertureIcon, CloseIcon, FlashIcon, HangUpIcon, MicIcon, MicOffIcon, WarningIcon } from "./icons";

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function recognitionClass(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// What the call says. A new `id` starts over (anything still being said is dropped); the same
// `id` with a higher `part` adds lines to it, as the answer is written. `answer` grows when a
// finished answer arrives: marks on the live picture are timed from it.
export type Speech = { id: number; part: number; lines: string[]; answer: number };

const LIVE_MARKS_MS = 15_000;
// A mark the live model drew: long enough to look, short enough that a moved camera does not lie.
const QUICK_MARK_MS = 12_000;
// A mark that is being followed on the picture stays longer: it moves with its part.
const TRACKED_MARK_MS = 30_000;
// The small grey copy of the picture the follower works on, and how often it looks.
const TRACK_WIDTH = 160;
const TRACK_MS = 120;
// This many looks in a row without finding the part, and the mark comes off.
const TRACK_PATIENCE = 12;
// Following a mark as the camera moves. Off: on a real phone camera the mark shook and drifted
// instead of holding its part, and a steady mark with an honest note is better than a nervous
// one. The mark is drawn where the look found the part and stays there for a few seconds.
const FOLLOW_MARKS = false;
// The notice at the bottom of a video call is shown when the call opens, then makes room.
const NOTICE_MS = 8_000;
const ZOOMS = [1, 2, 3] as const;

// A part circled on the live picture. `state` picks its colour and its word in the legend:
// the part being discussed, a part already checked, or a part to be careful with.
type MarkState = "current" | "checked" | "caution";
type QuickMark = { id: number; n: number; label: string; state: MarkState; box: { x: number; y: number; w: number; h: number } };
const MARK_TONE: Record<MarkState, { border: string; fill: string; ink: string }> = {
  current: { border: "border-signal", fill: "bg-signal", ink: "text-night" },
  checked: { border: "border-[#5fc393]", fill: "bg-[#5fc393]", ink: "text-night" },
  caution: { border: "border-[#ff6b5e]", fill: "bg-[#ff6b5e]", ink: "text-night" },
};

// The marks of the last answer, drawn straight on the live picture. The picture sent to the
// agent is exactly what the screen shows (see `frame`), so a mark's position on the picture is
// its position on the screen. Marks sit where the part was when the picture was taken, so they
// are shown for a short while only; the still picture with the same marks then takes over.
function LiveMarks({ marks }: { marks: DocMark[] }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {marks.map((m, i) => (
        <span key={i}>
          <span
            className="absolute rounded-lg border-[3px] border-signal shadow-[0_0_0_1.5px_var(--color-night),inset_0_0_0_1.5px_var(--color-night)]"
            style={{ left: `${m.box.x / 10}%`, top: `${m.box.y / 10}%`, width: `${m.box.w / 10}%`, height: `${m.box.h / 10}%` }}
          />
          <span
            className="absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-signal font-mono text-sm font-medium text-night shadow-[0_0_0_1.5px_var(--color-night)]"
            style={{ left: `${m.box.x / 10}%`, top: `${m.box.y / 10}%` }}
          >
            {i + 1}
          </span>
        </span>
      ))}
    </div>
  );
}

export function CallView({
  kind,
  kbId,
  conversationId,
  kbName,
  disclaimer,
  title,
  screen,
  speech,
  busy,
  progress,
  visual,
  onUtterance,
  onAck,
  onHangUp,
  onLiveAsk,
}: {
  kind: "voice" | "video";
  kbId: string;
  // The conversation this call belongs to, for the environment's log.
  conversationId?: string;
  kbName: string;
  disclaimer: string;
  title: string;
  screen: Screen;
  speech: Speech;
  busy: boolean;
  progress?: Progress;
  // The frame the last answer points at, with its marks.
  visual?: { frames: string[]; marks: DocMark[] };
  onUtterance: (text: string, frame?: string) => void;
  onAck: (symptomId: string) => void;
  // `asked`: something was asked in the call, so the short survey may follow.
  onHangUp: (asked?: boolean) => void;
  // Asks the verified answer engine on behalf of the live model, and returns what it answered.
  // Present: the call tries the live model first, and falls back to the classic call.
  onLiveAsk?: (question: string, frame?: string) => Promise<unknown>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const speaking = useRef(false);
  const live = useRef(true);
  const [heard, setHeard] = useState("");
  const [saying, setSaying] = useState<string[]>([]);
  const [state, setState] = useState<"listening" | "speaking" | "idle">("idle");
  const [muted, setMuted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  // "live": the phone talks to the live model. "classic": browser speech recognition and the
  // voice player. "starting": asking the server for a live call.
  const [mode, setMode] = useState<"starting" | "live" | "classic">(onLiveAsk ? "starting" : "classic");
  const liveCall = useRef<LiveCall | null>(null);
  const liveAsk = useRef(onLiveAsk);
  // Which answer's marks are on the live picture right now (they are removed after a while).
  const [liveFor, setLiveFor] = useState(0);
  useEffect(() => {
    const show = setTimeout(() => setLiveFor(speech.answer), 0);
    const hide = setTimeout(() => setLiveFor(0), LIVE_MARKS_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [speech.answer]);

  // Parts the live model circled on the picture, and the spot the technician touched. Both sit
  // where things were a moment ago, so they fade after a few seconds.
  const [quick, setQuick] = useState<QuickMark[]>([]);
  // The small grey copy of what is on screen, for following marks (set once the camera is known).
  const smallRef = useRef<() => Gray | null>(() => null);
  const [touched, setTouched] = useState<{ x: number; y: number; id: number } | null>(null);
  const touchedRef = useRef<{ x: number; y: number } | null>(null);
  const markId = useRef(0);
  // What the follower remembers of each mark: the patch around its part, where the patch
  // was last found (in the small grey picture), and how many looks in a row missed it.
  const tracks = useRef(new Map<number, { template: Template; x: number; y: number; missed: number }>());
  const removeMark = useCallback((id: number) => {
    tracks.current.delete(id);
    setQuick((now) => now.filter((m) => m.id !== id).map((m, i) => ({ ...m, n: i + 1 })));
  }, []);
  // `seen`: the small grey picture taken when the look was asked for. The part is found in it
  // at the box the look returned, and then caught up with in the picture as it is now.
  const addMark = useCallback(
    (mark: Omit<QuickMark, "id" | "n">, seen?: Gray | null) => {
      const id = ++markId.current;
      let box = mark.box;
      const now = smallRef.current();
      const cx = ((mark.box.x + mark.box.w / 2) / 1000) * (seen?.w ?? 0);
      const cy = ((mark.box.y + mark.box.h / 2) / 1000) * (seen?.h ?? 0);
      const template = FOLLOW_MARKS && seen ? templateAt(seen, cx, cy) : null;
      if (template && now && seen && now.w === seen.w && now.h === seen.h) {
        // The camera may have moved while the look ran: find the part where it is now.
        const rough = locate(now, template, cx, cy, 44, 2);
        const fine = rough.score <= LOST ? locate(now, template, rough.x, rough.y, 2) : rough;
        if (fine.score <= LOST) {
          box = { ...mark.box, x: mark.box.x + ((fine.x - cx) / now.w) * 1000, y: mark.box.y + ((fine.y - cy) / now.h) * 1000 };
          tracks.current.set(id, { template, x: fine.x, y: fine.y, missed: 0 });
        }
      }
      const tracked = tracks.current.has(id);
      // The same part marked again replaces its earlier mark (its state may have changed).
      setQuick((list) => {
        for (const old of list) if (old.label === mark.label) tracks.current.delete(old.id);
        return [...list.filter((m) => m.label !== mark.label).slice(-2), { ...mark, box, id, n: 0 }].map((m, i) => ({ ...m, n: i + 1 }));
      });
      setTimeout(() => removeMark(id), tracked ? TRACKED_MARK_MS : QUICK_MARK_MS);
    },
    [removeMark],
  );
  // The safety warning of the last answer: shown by the app, whatever the model says aloud.
  const [caution, setCaution] = useState<string | null>(null);
  // Each warning is shown once in a call. A warning is known by its topic, not by its wording:
  // the fast search and the checked answer word the same warning differently.
  const warned = useRef(new Set<string>());
  const warn = useCallback((text: string | null | undefined) => {
    if (!text) return;
    const topic = Object.values(T.doc.topics).find((t) => text.includes(t)) ?? text;
    if (warned.current.has(topic)) return;
    warned.current.add(topic);
    setCaution(text);
  }, []);
  // The camera's light, where the phone lets a page switch it; and how far the picture is zoomed.
  const [torch, setTorch] = useState<"none" | "off" | "on">("none");
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const zoomRef = useRef(1);
  const [notice, setNotice] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setNotice(false), NOTICE_MS);
    return () => clearTimeout(t);
  }, []);
  // The call's record: sent to the server every few seconds and when the call ends, so a call
  // can be read afterwards (what was heard, what was said, what each tool returned).
  const traced = useRef<TraceEvent[]>([]);
  const flushTrace = useRef<(last?: boolean) => void>(() => {});
  const [callId] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  useEffect(() => {
    const send = (last = false) => {
      const events = traced.current.splice(0);
      if (!events.length) return;
      void fetch("/api/voice/trace", { method: "POST", keepalive: last, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId, kbId, kind, conversationId, events }) }).catch(() => {});
    };
    flushTrace.current = send;
    const timer = setInterval(send, 4000);
    return () => {
      clearInterval(timer);
      send(true);
    };
  }, [callId, kbId, kind, conversationId]);
  // Whether anything was asked in this call: only then is the short survey worth showing.
  const asked = useRef(0);
  // The still picture of the last checked answer can be closed.
  const [closedFor, setClosedFor] = useState(0);

  const busyRef = useRef(busy);
  const mutedRef = useRef(muted);
  const utter = useRef(onUtterance);
  useEffect(() => {
    busyRef.current = busy;
    mutedRef.current = muted;
    utter.current = onUtterance;
    liveAsk.current = onLiveAsk;
  });

  // A still from the live camera, sent with what the technician says. Only the part of the
  // camera picture that is on screen is sent (the video fills the screen and is cropped to it),
  // so the agent sees what the technician sees.
  const frame = useCallback((ring?: { x: number; y: number }, longSide = 1280): string | undefined => {
    const v = video.current;
    if (kind !== "video" || !v || !v.videoWidth || !v.clientWidth) return undefined;
    const cover = Math.max(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
    // Zoomed in, only the middle of the picture is on screen, and only that is sent.
    const sw = v.clientWidth / cover / zoomRef.current;
    const sh = v.clientHeight / cover / zoomRef.current;
    const scale = Math.min(1, longSide / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const g = canvas.getContext("2d")!;
    g.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    if (ring) {
      // Where the technician touched (thousandths of the picture): a ring the model can see.
      g.lineWidth = Math.max(4, canvas.width / 120);
      g.strokeStyle = "#f2b24c";
      g.beginPath();
      g.arc((ring.x / 1000) * canvas.width, (ring.y / 1000) * canvas.height, canvas.width / 14, 0, Math.PI * 2);
      g.stroke();
    }
    return canvas.toDataURL("image/jpeg", 0.8);
  }, [kind]);

  // The live model asked to mark a part or to look at the picture. It does not point by
  // itself (it sees a small, blurry copy): the full picture goes to a careful look on the
  // server, and the mark is drawn only where that look found the part.
  const videoTool = useRef<(tool: VideoTool) => Promise<VideoToolResult>>(async () => ({ result: { ok: false }, quiet: true }));
  useEffect(() => {
    videoTool.current = async ({ name, args }) => {
      const ring = touchedRef.current;
      const image = frame(ring ?? undefined);
      const seen = FOLLOW_MARKS ? smallRef.current() : null;
      if (!image) return { result: { ok: false, note: "no picture" }, quiet: true };
      const marking = name === "mark_on_picture";
      const pointing = marking && args.pointing === true;
      const label = typeof args.label === "string" ? args.label.trim() : "";
      const english = typeof args.english === "string" ? args.english : undefined;
      const question = typeof args.question === "string" ? args.question : "";
      const state: MarkState = args.state === "checked" || args.state === "caution" ? args.state : "current";
      const res = await fetch("/api/voice/look", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kbId, image, ring: Boolean(ring), ...(marking ? (pointing || !label ? { pointing: true } : { find: label, english }) : { question }) }),
      }).catch(() => null);
      const look = res?.ok ? ((await res.json()) as { visible: boolean; quality: string; name: string; seen: string; box?: QuickMark["box"] }) : null;
      if (!look) return { result: { ok: false, note: "could not look at the picture" }, quiet: false };
      const shown = look.visible && look.box ? look.name || label : "";
      if (shown && look.box) addMark({ label: pointing || ring ? look.name || label : label || look.name, state, box: look.box }, seen);
      if (marking) {
        // Found and marked: nothing to say about it, unless the model asked what the finger points at.
        return { result: { marked: Boolean(shown), name: look.name, quality: look.quality, ...(look.seen ? { seen: look.seen } : {}) }, quiet: Boolean(shown) && !pointing && !look.seen };
      }
      return { result: { seen: look.seen || (look.visible ? look.name : ""), visible: look.visible, quality: look.quality }, quiet: false };
    };
  });

  // Following the marks: a few times a second each mark's patch is looked for near where it
  // was, and the mark moves with it. A part that cannot be found any more loses its mark.
  useEffect(() => {
    if (kind !== "video") return;
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    smallRef.current = () => {
      const v = video.current;
      if (!g || !v || !v.videoWidth || !v.clientWidth) return null;
      const cover = Math.max(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
      const sw = v.clientWidth / cover / zoomRef.current;
      const sh = v.clientHeight / cover / zoomRef.current;
      const w = TRACK_WIDTH;
      const h = Math.max(1, Math.round((TRACK_WIDTH * sh) / sw));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      g.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, w, h);
      return toGray(g.getImageData(0, 0, w, h).data, w, h);
    };
    const timer = setInterval(() => {
      if (!tracks.current.size) return;
      const now = smallRef.current();
      if (!now) return;
      const moved = new Map<number, { dx: number; dy: number }>();
      const lost: number[] = [];
      for (const [id, t] of tracks.current) {
        const found = locate(now, t.template, t.x, t.y, 9);
        if (found.score > LOST) {
          if (++t.missed > TRACK_PATIENCE) lost.push(id);
          continue;
        }
        t.missed = 0;
        if (found.x !== t.x || found.y !== t.y) moved.set(id, { dx: ((found.x - t.x) / now.w) * 1000, dy: ((found.y - t.y) / now.h) * 1000 });
        t.x = found.x;
        t.y = found.y;
      }
      if (moved.size) setQuick((list) => list.map((m) => (moved.has(m.id) ? { ...m, box: { ...m.box, x: m.box.x + moved.get(m.id)!.dx, y: m.box.y + moved.get(m.id)!.dy } } : m)));
      lost.forEach(removeMark);
    }, TRACK_MS);
    return () => clearInterval(timer);
  }, [kind, removeMark]);


  const listen = useCallback(() => {
    const r = recognition.current;
    if (!r || !live.current || speaking.current || busyRef.current || mutedRef.current) return;
    try {
      r.start();
      setState("listening");
    } catch {
      // Already listening.
    }
  }, []);

  // Camera (video calls only).
  useEffect(() => {
    if (kind !== "video") return;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) video.current.srcObject = s;
        const caps = s.getVideoTracks()[0]?.getCapabilities?.() as { torch?: boolean } | undefined;
        if (caps?.torch) setTorch("off");
      })
      .catch(() => setProblem(T.call.noCamera));
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [kind]);

  // The live call: a token from the server, then the phone talks to the live model directly.
  // Anything that goes wrong before it is connected falls back to the classic call.
  useEffect(() => {
    if (!onLiveAsk) return;
    let cancelled = false;
    const call = new LiveCall({
      onState: (s) => setState(s === "speaking" ? "speaking" : s === "listening" ? "listening" : "idle"),
      onHeard: (text) => setHeard((now) => (now + text).slice(-200)),
      onSaid: (text, fresh) => {
        if (fresh) setHeard("");
        setSaying((now) => (fresh || !now.length ? [text] : [now[0] + text]));
      },
      // Two things at once: the fast search the model speaks from (a second or two), and the
      // full checked answer, which lands in the chat with its pages.
      onVideoTool: (tool) => videoTool.current(tool),
      onTrace: (event) => void traced.current.push(event),
      onTool: async (question, english) => {
        asked.current++;
        const picture = frame();
        // The checked answer carries the safety warning too: shown when it arrives.
        void liveAsk.current?.(question, picture)?.then((r) => {
          const warning = (r as { warning?: string } | null)?.warning;
          warn(warning);
        });
        const res = await fetch("/api/voice/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbId, question, english, conversationId, video: kind === "video" }) }).catch(() => null);
        const found = res?.ok ? ((await res.json()) as { caution?: string }) : null;
        warn(found?.caution);
        return found ?? { kind: "error", note: T.doc.error };
      },
      // The live connection dropped in the middle: carry on with the classic call.
      onError: () => {
        if (cancelled) return;
        liveCall.current = null;
        setProblem(T.call.liveEnded);
        setMode("classic");
      },
    });
    (async () => {
      const res = await fetch("/api/voice/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbId, video: kind === "video" }) }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { url: string; model: string }) : null;
      if (cancelled) return;
      if (!body) return setMode("classic");
      try {
        await call.start(body.url, body.model, kind === "video" ? frame : undefined);
        if (cancelled) return call.stop();
        liveCall.current = call;
        setMode("live");
      } catch {
        call.stop();
        if (!cancelled) setMode("classic");
      }
    })();
    // Only when the call screen closes. Not when the mode changes: moving from "starting" to
    // "live" must not hang up the call it just connected.
    return () => {
      cancelled = true;
      call.stop();
      liveCall.current = null;
      // The last lines of the record (what was being said, "ended") go out now.
      flushTrace.current(true);
    };
    // Runs once per call; `frame` and `kbId` do not change during it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speech recognition (classic call only).
  useEffect(() => {
    if (mode !== "classic") return;
    live.current = true;
    const R = recognitionClass();
    if (!R) {
      const t = setTimeout(() => setProblem(T.call.noSpeech), 0);
      return () => clearTimeout(t);
    }
    const r = new R();
    r.lang = "he-IL";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final ||= e.results[i].isFinal;
      }
      setHeard(text);
      if (final && text.trim()) {
        setState("idle");
        utter.current(text.trim(), frame());
        // The sentence was sent: the shutter button must not send it again.
        setTimeout(() => setHeard(""), 1500);
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setProblem(T.call.noMic);
    };
    r.onend = () => setTimeout(listen, 250);
    recognition.current = r;
    return () => {
      live.current = false;
      r.onend = null;
      r.abort();
    };
  }, [frame, listen, mode]);

  // The player tells the call when it starts and stops talking. While it talks, the microphone
  // listens for the technician talking over it; when it stops, the call listens for a sentence.
  const interrupt = useCallback(() => (liveCall.current ? liveCall.current.interrupt() : voicePlayer().stop()), []);
  useEffect(() => {
    if (mode !== "classic") return;
    const player = voicePlayer();
    let stopHearing: (() => void) | undefined;
    player.onState = (talking) => {
      speaking.current = talking;
      setState(talking ? "speaking" : "idle");
      stopHearing?.();
      stopHearing = undefined;
      if (talking) {
        recognition.current?.abort();
        if (!mutedRef.current) stopHearing = listenForSpeech(interrupt);
      } else {
        // A moment for the microphone to be released before speech recognition takes it.
        setTimeout(listen, 200);
      }
    };
    return () => {
      player.onState = () => {};
      stopHearing?.();
      player.stop();
    };
  }, [listen, interrupt, mode]);

  // Say the new lines. A new `id` replaces what was being said; a new `part` adds to it.
  useEffect(() => {
    // In a live call the model speaks for itself.
    if (mode !== "classic") return;
    const fresh = speech.part === 0;
    // A new turn with nothing to say yet: clear the old captions, and wait for the answer.
    if (!speech.lines.length) {
      if (!fresh) return;
      const clear = setTimeout(() => setSaying([]), 0);
      return () => clearTimeout(clear);
    }
    const show = setTimeout(() => setSaying((now) => (fresh ? speech.lines : [...now, ...speech.lines])), 0);
    voicePlayer().say(speech.lines.map(forVoice), fresh);
    return () => clearTimeout(show);
  }, [speech.id, speech.part, speech.lines, mode]);

  // After the server answers, listening resumes once speaking is done (or right away).
  useEffect(() => {
    if (!busy && !speaking.current) {
      const t = setTimeout(listen, 0);
      return () => clearTimeout(t);
    }
  }, [busy, listen]);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // A dialog: focus moves in, Escape ends the call, focus returns to where it was.
  const root = useRef<HTMLDivElement>(null);
  const hangUp = useRef(onHangUp);
  useEffect(() => {
    hangUp.current = onHangUp;
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hangUp.current(asked.current > 0);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (liveCall.current) return liveCall.current.setMuted(next);
    if (next) {
      recognition.current?.abort();
      setState("idle");
    } else listen();
  };

  const last = screen.items.at(-1);
  const lastHazard = last?.kind === "doc_hazard" ? last : undefined;
  const status =
    mode === "starting"
      ? T.call.connecting
      : busy && mode === "classic"
        ? progress
          ? T.progress[progress]
          : T.call.connecting
        : state === "speaking"
          ? T.call.speaking
          : state === "listening"
            ? T.call.listening
            : "";
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label={kind === "video" ? T.call.video : T.call.voice} className="on-dark fixed inset-0 z-50 mx-auto flex max-w-md flex-col overflow-hidden bg-night text-white">
      {kind === "video" && <video ref={video} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover transition-transform" style={{ transform: `scale(${zoom})` }} />}
      {kind === "video" && (
        // A touch on the picture points at a part: it is ringed at once, and the live model is told where.
        <div
          aria-hidden
          onClick={(e) => {
            if (mode !== "live" || !liveCall.current) return;
            const box = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - box.left) / box.width) * 1000;
            const y = ((e.clientY - box.top) / box.height) * 1000;
            const id = ++markId.current;
            setTouched({ x, y, id });
            // The ring stays in the pictures sent for a careful look while it is on screen.
            touchedRef.current = { x, y };
            setTimeout(() => {
              setTouched((now) => {
                if (now?.id === id) touchedRef.current = null;
                return now?.id === id ? null : now;
              });
            }, 6000);
            liveCall.current.hush();
            liveCall.current.point(x, y, frame({ x, y }));
          }}
          className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/75"
        />
      )}
      {kind === "video" && (
        // Above the cards: a mark is never hidden behind the legend that explains it.
        <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
          {quick.map((m) => (
            <span key={m.id}>
              <span
                className={`absolute rounded-md border-2 shadow-[0_0_0_1px_var(--color-night),inset_0_0_0_1px_var(--color-night)] ${MARK_TONE[m.state].border}`}
                style={{ left: `${m.box.x / 10}%`, top: `${m.box.y / 10}%`, width: `${m.box.w / 10}%`, height: `${m.box.h / 10}%` }}
              />
              {/* The number sits outside the corner, so it never covers the part itself. */}
              <span
                className={`absolute grid h-[22px] min-w-[22px] -translate-x-full -translate-y-full place-items-center rounded-full px-1 font-mono text-[13px] font-medium leading-none shadow-[0_0_0_1px_var(--color-night)] ${MARK_TONE[m.state].fill} ${MARK_TONE[m.state].ink}`}
                style={{ left: `max(22px, ${m.box.x / 10}%)`, top: `max(22px, ${m.box.y / 10}%)` }}
              >
                {m.n}
              </span>
            </span>
          ))}
          {touched && <span className="absolute h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1.5px_var(--color-night)]" style={{ left: `${touched.x / 10}%`, top: `${touched.y / 10}%` }} />}
        </div>
      )}
      {kind === "video" && visual && !busy && liveFor === speech.answer && <LiveMarks marks={visual.marks.filter((m) => m.frame === visual.marks[0].frame)} />}

      <header className="pointer-events-none relative flex items-center justify-between px-5 pb-2 pt-5">
        <div className="min-w-0">
          <p className="truncate text-[17px] font-semibold">{title}</p>
          <p className="flex gap-2 text-[13px] text-white/70">
            <span>{kind === "video" ? T.call.video : T.call.voice}</span>
            <span className="font-mono">{clock}</span>
          </p>
        </div>
        <span className="max-w-[45%] truncate text-[13px] text-white/70">{kbName}</span>
      </header>

      <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col justify-end gap-4 px-5 pb-4 [&>*]:pointer-events-auto">
        {kind === "voice" && (
          <div className="flex flex-1 items-center justify-center">
            {/* While the assistant talks, a tap on the circle cuts it short. */}
            <button
              onClick={interrupt}
              disabled={state !== "speaking"}
              aria-label={T.call.interrupt}
              className={`grid h-28 w-28 place-items-center rounded-full bg-white/10 ${state === "speaking" ? "ring-8 ring-signal/30" : state === "listening" ? "ring-4 ring-white/15" : ""}`}
            >
              <LogoMark size={64} className="rounded-[24%] ring-2 ring-white/40" />
            </button>
          </div>
        )}

        {problem && (
          <div role="alert" className="flex flex-col gap-2.5 rounded-2xl bg-night/90 p-3.5">
            <p className="text-[17px] leading-[25px]">{problem}</p>
            <button onClick={() => onHangUp(false)} className="h-12 rounded-[14px] bg-white text-base font-medium text-night">
              {T.call.backToChat}
            </button>
          </div>
        )}

        {caution && (
          <div className="mb-auto flex flex-col gap-2">
            {caution && (
              <div role="alert" className="flex items-start gap-2.5 rounded-2xl border-2 border-[#ff6b5e] bg-night/90 py-1.5 pe-1 ps-3">
                <WarningIcon className="mt-2.5 h-6 w-6 shrink-0 text-[#ff6b5e]" />
                <p className="min-w-0 flex-1 py-2 text-[15px] leading-[22px]">{caution}</p>
                <button
                  onClick={() => setCaution(null)}
                  aria-label={T.header.close}
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-full active:bg-white/10"
                >
                  <CloseIcon />
                </button>
              </div>
            )}
          </div>
        )}
        {quick.length > 0 && (
          // What each number on the picture is, in words: the colour is never the only sign.
          // Low on the screen, with the captions: the picture above stays clear for the marks.
          <div role="status" className="anim-rise flex flex-col gap-1 rounded-2xl bg-night/85 px-3 py-2">
            {!FOLLOW_MARKS && <p className="text-sm text-signal">{T.call.liveNote}</p>}
            <p className="text-sm text-white/75">{T.call.marksLegend}</p>
            <ol className="flex flex-col gap-1.5">
              {quick.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5 text-[16px]">
                  <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-sm font-medium ${MARK_TONE[m.state].fill} ${MARK_TONE[m.state].ink}`}>
                    {m.n}
                  </span>
                  <span className="min-w-0 flex-1">{m.label}</span>
                  {m.state !== "current" && <span className="shrink-0 text-[13px] text-white/75">{T.call.markState[m.state]}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
        {visual && !busy && closedFor !== speech.answer && (
          // Never taller than half the screen: it scrolls inside, and the X closes it.
          <div className={`anim-rise relative flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto rounded-2xl bg-night/90 p-2.5 ${kind === "video" && liveFor === speech.answer ? "mb-auto" : ""}`}>
            <button onClick={() => setClosedFor(speech.answer)} aria-label={T.header.close} className="sticky top-0 z-10 -mb-12 grid h-12 w-12 shrink-0 place-items-center self-end rounded-full bg-night/80">
              <CloseIcon />
            </button>
            {/* While the marks are on the live picture, the still copy waits; then it takes over. */}
            {!(kind === "video" && liveFor === speech.answer) && (
              <MarkedImage
                src={visual.frames[visual.marks[0].frame]}
                marks={visual.marks.filter((m) => m.frame === visual.marks[0].frame).map((m, i) => ({ ...m, n: i + 1, symptomTitle: "" }))}
              />
            )}
            {kind === "video" && liveFor === speech.answer && <p className="text-sm text-signal">{T.call.liveNote}</p>}
            <p className="text-sm text-white/75">{T.call.marksLegend}</p>
            <MarksLegend marks={visual.marks.filter((m) => m.frame === visual.marks[0].frame)} />
          </div>
        )}
        {lastHazard ? (
          <DocHazard topic={lastHazard.topic} sources={lastHazard.sources} kbId={kbId} />
        ) : screen.mode === "stop" && screen.pendingStop ? (
          <StopCard onAck={() => onAck(screen.pendingStop!.symptomId)} />
        ) : screen.danger ? (
          <StopCard danger />
        ) : (
          saying.length > 0 && (
            <div aria-live="polite" className={`flex flex-col gap-1.5 overflow-y-auto rounded-2xl bg-night/85 p-3.5 font-medium ${kind === "video" ? "max-h-[24dvh] text-[17px] leading-[25px]" : "max-h-[40dvh] text-[19px] leading-7"}`}>
              {saying.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )
        )}

        {heard && (
          <p className="rounded-xl bg-night/85 px-3 py-2 text-[17px]">
            <span className="text-white/75">{T.call.you}</span> <span>{heard}</span>
          </p>
        )}
        {state === "speaking" && kind === "video" && (
          <button onClick={interrupt} className="h-12 self-start rounded-full bg-white px-5 text-base font-medium text-night">
            {T.call.interrupt}
          </button>
        )}
        <p role="status" className="min-h-6 text-base text-white/80">
          {state === "speaking" && !busy ? (kind === "video" ? T.call.talkToInterrupt : T.call.tapToInterrupt) : kind === "video" && mode === "live" && state === "listening" ? T.call.tapToPoint : status}
        </p>
      </div>

      <div className="relative flex items-start justify-center gap-4 px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
        <div className="flex w-20 flex-col items-center gap-1.5">
          <button
            onClick={toggleMute}
            aria-label={muted ? T.call.unmute : T.call.mute}
            aria-pressed={muted}
            className={`grid h-16 w-16 place-items-center rounded-full ${muted ? "bg-white text-night" : "bg-white/20"}`}
          >
            {muted ? <MicOffIcon className="h-7 w-7" /> : <MicIcon className="h-7 w-7" />}
          </button>
          <span aria-hidden className="text-center text-sm">
            {muted ? T.call.unmute : T.call.muteShort}
          </span>
        </div>
        {/* The classic call sends one picture per sentence, or on this button. The live call
            sees the camera all the time, so there is nothing to send by hand. */}
        {kind === "video" && mode === "classic" && (
          <div className="flex w-24 flex-col items-center gap-1.5">
            <button
              onClick={() => {
                const f = frame();
                if (f) onUtterance("", f);
              }}
              disabled={busy}
              aria-label={T.call.snapshot}
              className="grid h-16 w-16 place-items-center rounded-full border-4 border-white bg-white/10 disabled:opacity-50"
            >
              <ApertureIcon className="h-7 w-7" />
            </button>
            <span aria-hidden className="text-center text-sm">
              {T.call.snapshot}
            </span>
          </div>
        )}
        {kind === "video" && torch !== "none" && (
          <div className="flex w-20 flex-col items-center gap-1.5">
            <button
              onClick={() => {
                const next = torch === "on" ? "off" : "on";
                void stream.current
                  ?.getVideoTracks()[0]
                  ?.applyConstraints({ advanced: [{ torch: next === "on" } as MediaTrackConstraintSet] })
                  .then(() => setTorch(next))
                  .catch(() => setTorch("none"));
              }}
              aria-label={T.call.flash}
              aria-pressed={torch === "on"}
              className={`grid h-16 w-16 place-items-center rounded-full ${torch === "on" ? "bg-white text-night" : "bg-white/20"}`}
            >
              <FlashIcon className="h-7 w-7" />
            </button>
            <span aria-hidden className="text-center text-sm">
              {T.call.flash}
            </span>
          </div>
        )}
        {kind === "video" && (
          <div className="flex w-20 flex-col items-center gap-1.5">
            <button
              onClick={() => {
                const next = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length];
                zoomRef.current = next;
                setZoom(next);
                // Marks were placed on the picture as it was before the zoom changed.
                tracks.current.clear();
                setQuick([]);
              }}
              aria-label={`${T.call.zoom} ${zoom}×`}
              dir="ltr"
              className={`grid h-16 w-16 place-items-center rounded-full font-mono text-[17px] font-medium ${zoom > 1 ? "bg-white text-night" : "bg-white/20"}`}
            >
              {zoom}×
            </button>
            <span aria-hidden className="text-center text-sm">
              {T.call.zoom}
            </span>
          </div>
        )}
        <div className="flex w-20 flex-col items-center gap-1.5">
          <button onClick={() => onHangUp(asked.current > 0)} aria-label={T.call.hangUp} className="grid h-16 w-16 place-items-center rounded-full bg-danger">
            <HangUpIcon className="h-7 w-7" />
          </button>
          <span aria-hidden className="text-center text-sm">
            {T.call.hangUpShort}
          </span>
        </div>
      </div>
      {/* In a video call the notice is shown when the call opens, then leaves the picture clear. */}
      {(kind === "voice" || notice) && <p className="relative px-4 pb-4 text-center text-[13px] leading-[18px] text-white/75">{disclaimer}</p>}
    </div>
  );
}
