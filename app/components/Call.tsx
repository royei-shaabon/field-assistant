"use client";

// Live call with the assistant: the technician talks (browser speech recognition, Hebrew), the
// assistant answers out loud (browser speech synthesis) with the same KB lines the chat shows,
// and in a video call the camera stays on and a frame goes with every sentence.
// The call is a front end to the same conversation: everything said lands in the chat.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Progress } from "@/lib/conversation";
import type { Screen } from "@/lib/screen";
import { T } from "@/lib/ui-text";
import type { DocMark } from "@/lib/docs/ask";
import { MarkedImage, StopCard } from "./Chat";
import { DocHazard, MarksLegend } from "./DocChat";
import { LogoMark } from "./Logo";
import { ApertureIcon, HangUpIcon, MicIcon, MicOffIcon } from "./icons";

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

function hebrewVoice(): SpeechSynthesisVoice | undefined {
  return window.speechSynthesis?.getVoices().find((v) => v.lang.toLowerCase().startsWith("he"));
}

export type Speech = { id: number; lines: string[] };

const LIVE_MARKS_MS = 15_000;

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
            className="absolute rounded-lg border-[3px] border-signal shadow-[0_0_0_1.5px_var(--color-ink),inset_0_0_0_1.5px_var(--color-ink)]"
            style={{ left: `${m.box.x / 10}%`, top: `${m.box.y / 10}%`, width: `${m.box.w / 10}%`, height: `${m.box.h / 10}%` }}
          />
          <span
            className="absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-signal font-mono text-sm font-medium text-ink shadow-[0_0_0_1.5px_var(--color-ink)]"
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
}: {
  kind: "voice" | "video";
  kbId: string;
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
  onHangUp: () => void;
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
  // Which answer's marks are on the live picture right now (they are removed after a while).
  const [liveFor, setLiveFor] = useState(0);
  useEffect(() => {
    const show = setTimeout(() => setLiveFor(speech.id), 0);
    const hide = setTimeout(() => setLiveFor(0), LIVE_MARKS_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [speech.id]);

  const busyRef = useRef(busy);
  const mutedRef = useRef(muted);
  const utter = useRef(onUtterance);
  useEffect(() => {
    busyRef.current = busy;
    mutedRef.current = muted;
    utter.current = onUtterance;
  });

  // A still from the live camera, sent with what the technician says. Only the part of the
  // camera picture that is on screen is sent (the video fills the screen and is cropped to it),
  // so the agent sees what the technician sees.
  const frame = useCallback((): string | undefined => {
    const v = video.current;
    if (kind !== "video" || !v || !v.videoWidth || !v.clientWidth) return undefined;
    const cover = Math.max(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
    const sw = v.clientWidth / cover;
    const sh = v.clientHeight / cover;
    const scale = Math.min(1, 1280 / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext("2d")!.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  }, [kind]);

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
      })
      .catch(() => setProblem(T.call.noCamera));
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [kind]);

  // Speech recognition.
  useEffect(() => {
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
      window.speechSynthesis?.cancel();
    };
  }, [frame, listen]);

  // Say the new lines, then listen again.
  useEffect(() => {
    if (!speech.lines.length) return;
    const show = setTimeout(() => setSaying(speech.lines), 0);
    const synth = window.speechSynthesis;
    if (!synth) {
      const t = setTimeout(listen, 0);
      return () => (clearTimeout(show), clearTimeout(t));
    }
    recognition.current?.abort();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(speech.lines.map((l) => (/[.?!:,]$/.test(l) ? l : `${l}.`)).join(" "));
    u.lang = "he-IL";
    const voice = hebrewVoice();
    if (voice) u.voice = voice;
    u.rate = 1.05;
    speaking.current = true;
    const start = setTimeout(() => setState("speaking"), 0);
    u.onend = u.onerror = () => {
      speaking.current = false;
      setState("idle");
      listen();
    };
    try {
      synth.speak(u);
    } catch {
      // No usable voice: the lines stay on screen as captions, and the call keeps listening.
      speaking.current = false;
      setTimeout(listen, 0);
    }
    return () => {
      clearTimeout(show);
      clearTimeout(start);
    };
  }, [speech.id, speech.lines, listen]);

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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hangUp.current();
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
    if (next) {
      recognition.current?.abort();
      setState("idle");
    } else listen();
  };

  const last = screen.items.at(-1);
  const lastHazard = last?.kind === "doc_hazard" ? last : undefined;
  const status = busy ? (progress ? T.progress[progress] : T.call.connecting) : state === "speaking" ? T.call.speaking : state === "listening" ? T.call.listening : "";
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label={kind === "video" ? T.call.video : T.call.voice} className="on-dark fixed inset-0 z-50 mx-auto flex max-w-md flex-col bg-ink text-white">
      {kind === "video" && <video ref={video} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" />}
      {kind === "video" && <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/75" />}
      {kind === "video" && visual && !busy && liveFor === speech.id && <LiveMarks marks={visual.marks.filter((m) => m.frame === visual.marks[0].frame)} />}

      <header className="relative flex items-center justify-between px-5 pb-2 pt-5">
        <div className="min-w-0">
          <p className="truncate text-[17px] font-semibold">{title}</p>
          <p className="flex gap-2 text-xs text-white/70">
            <span>{kind === "video" ? T.call.video : T.call.voice}</span>
            <span className="font-mono">{clock}</span>
          </p>
        </div>
        <span className="max-w-[45%] truncate text-xs text-white/70">{kbName}</span>
      </header>

      <div className="relative flex flex-1 flex-col justify-end gap-4 px-5 pb-4">
        {kind === "voice" && (
          <div className="flex flex-1 items-center justify-center">
            <span className={`grid h-28 w-28 place-items-center rounded-full bg-white/10 ${state === "speaking" ? "ring-8 ring-signal/30" : state === "listening" ? "ring-4 ring-white/15" : ""}`}>
              <LogoMark size={64} className="rounded-[24%] ring-2 ring-white/40" />
            </span>
          </div>
        )}

        {problem && (
          <div role="alert" className="flex flex-col gap-2.5 rounded-2xl bg-ink/90 p-3.5">
            <p className="text-[17px] leading-[25px]">{problem}</p>
            <button onClick={onHangUp} className="h-12 rounded-[14px] bg-white text-base font-medium text-ink">
              {T.call.backToChat}
            </button>
          </div>
        )}

        {visual && !busy && (
          <div className={`anim-rise flex flex-col gap-2 rounded-2xl bg-ink/85 p-2.5 ${kind === "video" && liveFor === speech.id ? "mb-auto" : ""}`}>
            {/* While the marks are on the live picture, the still copy waits; then it takes over. */}
            {!(kind === "video" && liveFor === speech.id) && (
              <MarkedImage
                src={visual.frames[visual.marks[0].frame]}
                marks={visual.marks.filter((m) => m.frame === visual.marks[0].frame).map((m, i) => ({ ...m, n: i + 1, symptomTitle: "" }))}
              />
            )}
            {kind === "video" && liveFor === speech.id && <p className="text-sm text-signal">{T.call.liveNote}</p>}
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
            <div aria-live="polite" className={`flex flex-col gap-1.5 overflow-y-auto rounded-2xl bg-ink/85 p-3.5 font-medium ${kind === "video" ? "max-h-[24dvh] text-[17px] leading-[25px]" : "max-h-[40dvh] text-[19px] leading-7"}`}>
              {saying.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )
        )}

        {heard && (
          <p className="rounded-xl bg-ink/85 px-3 py-2 text-[17px]">
            <span className="text-white/75">{T.call.you}</span> <span>{heard}</span>
          </p>
        )}
        <p role="status" className="h-6 text-base text-white/80">
          {status}
        </p>
      </div>

      <div className="relative flex items-start justify-center gap-7 px-5 pb-6 pt-2">
        <div className="flex w-20 flex-col items-center gap-1.5">
          <button
            onClick={toggleMute}
            aria-label={muted ? T.call.unmute : T.call.mute}
            aria-pressed={muted}
            className={`grid h-16 w-16 place-items-center rounded-full ${muted ? "bg-white text-ink" : "bg-white/20"}`}
          >
            {muted ? <MicOffIcon className="h-7 w-7" /> : <MicIcon className="h-7 w-7" />}
          </button>
          <span aria-hidden className="text-center text-sm">
            {muted ? T.call.unmute : T.call.muteShort}
          </span>
        </div>
        {kind === "video" && (
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
        <div className="flex w-20 flex-col items-center gap-1.5">
          <button onClick={onHangUp} aria-label={T.call.hangUp} className="grid h-16 w-16 place-items-center rounded-full bg-danger">
            <HangUpIcon className="h-7 w-7" />
          </button>
          <span aria-hidden className="text-center text-sm">
            {T.call.hangUpShort}
          </span>
        </div>
      </div>
      <p className="relative px-4 pb-4 text-center text-[13px] leading-[18px] text-white/75">{disclaimer}</p>
    </div>
  );
}
