"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientInput, Progress } from "@/lib/conversation";
import type { PartialAnswer } from "@/lib/docs/ask";
import type { DocInput } from "@/lib/docs/conversation";
import { LEGAL_LINKS } from "@/lib/legal-text";
import type { Screen } from "@/lib/screen";
import type { KbSummary } from "@/lib/server/kbs";
import { liveToolResult, partialSpeech, resumeSpeech, speechFor } from "@/lib/speech";
import { primeLiveAudio } from "@/lib/client/live";
import { voicePlayer } from "@/lib/client/voice";
import { canDictate, startDictation } from "@/lib/client/dictation";
import { dataUrlToImage, photoToDataUrl, thumbnail, videoToDataUrls } from "@/lib/client/image";
import {
  conversationsSnapshot,
  deleteConversation,
  visibleConversations,
  newConversationId,
  parseConversations,
  saveConversation,
  selectedKb,
  selectKb,
  subscribeConversations,
  type SavedConversation,
} from "@/lib/client/conversations";
import { T } from "@/lib/ui-text";
import { CallView, type Speech } from "./Call";
import { Logo } from "./Logo";
import { ChatTime, ChatView, type ProgressStep } from "./Chat";
import { ArrowIcon, CameraIcon, CloseIcon, MapIcon, MenuIcon, MicIcon, PhoneIcon, PlusIcon, SendIcon, VideoIcon } from "./icons";

const EMPTY: Screen = { items: [], mode: "identify", candidates: [], trees: [], danger: false };
const MAX_PHOTOS = 4;

type Active = { conversation: SavedConversation; screen: Screen };
type Input = ClientInput | DocInput;
type Reply = { events: SavedConversation["events"]; screen: Screen };
// What the technician attached and has not sent yet.
type Staged = { frames: string[]; media: "photo" | "video" };
// `at`: the time shown on the message while it waits for its answer.
type Pending = { said?: string; frames?: string[]; at?: string };

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

// Reads the NDJSON stream from /api/conversation: progress lines, then the result.
async function post(
  kbId: string,
  events: SavedConversation["events"],
  input: Input,
  // Which conversation this is and how it was asked (typed, voice call, video call): written
  // in the environment's log beside the question.
  meta: { conversationId: string; channel: "chat" | "voice" | "video" },
  onProgress: (p: Progress) => void,
  onPartial: (p: PartialAnswer) => void,
  signal: AbortSignal,
): Promise<Reply> {
  const res = await fetch("/api/conversation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kbId, events, input, ...meta }),
    signal,
  });
  if (!res.ok || !res.body) throw new HttpError(res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { progress?: Progress; partial?: PartialAnswer; result?: Reply; error?: string };
      if (msg.progress) onProgress(msg.progress);
      if (msg.partial) onPartial(msg.partial);
      if (msg.result) return msg.result;
      if (msg.error) throw new Error(msg.error);
    }
    if (done) throw new Error("stream ended without a result");
  }
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "אתמול";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

const DOT: Record<Screen["mode"], string> = {
  identify: "bg-signal",
  question: "bg-signal",
  stop: "bg-danger",
  done: "bg-ok",
  ended: "bg-danger",
};

// A hidden file input inside a label, so a tap opens the camera or the gallery on a phone.
function FilePicker({
  accept,
  multiple,
  onFiles,
  className,
  children,
}: {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`cursor-pointer ${className}`}>
      {children}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

// A side panel that behaves as a dialog: focus moves in, Tab stays inside, Escape closes, and
// focus returns to the button that opened it.
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const root = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () => [...(root?.querySelectorAll<HTMLElement>("button, a[href], select, input") ?? [])].filter((el) => !el.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close.current();
      if (e.key !== "Tab") return;
      const list = focusable();
      const first = list[0];
      const last = list.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);
  return ref;
}

function Menu({
  kbs,
  kbId,
  showStatus,
  onKb,
  recent,
  currentId,
  onOpen,
  onNew,
  onDelete,
  onClose,
}: {
  kbs: KbSummary[];
  kbId: string;
  // Fault-tree cases have a status (checking, stopped, done); document chats do not.
  showStatus: boolean;
  onKb: (id: string) => void;
  recent: SavedConversation[];
  currentId: string;
  onOpen: (c: SavedConversation) => void;
  onNew: () => void;
  onDelete: (c: SavedConversation) => void;
  onClose: () => void;
}) {
  const ref = useDialog(onClose);
  return (
    <div className="fixed inset-0 z-40 mx-auto flex max-w-md">
      <div aria-hidden onClick={onClose} className="absolute inset-0 bg-night/50" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={T.doc.menu} className="anim-rise relative flex w-[86%] flex-col bg-paper shadow-[0_0_32px_rgba(18,18,18,0.18)]">
        <div className="flex h-[60px] shrink-0 items-center justify-between pe-1.5 ps-4">
          <Logo size={30} />
          <button onClick={onClose} aria-label={T.header.close} className="grid h-12 w-12 place-items-center rounded-full active:bg-mist">
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pb-2">
          <div className="px-3">
            <button onClick={onNew} className="flex h-12 w-full items-center gap-3 rounded-[10px] bg-action px-4 text-[16px] font-medium text-white active:opacity-90">
              <PlusIcon />
              <span>{T.header.newCase}</span>
            </button>
          </div>

          {kbs.length > 1 && (
            <section className="px-3 pt-5">
              <h2 className="px-1 pb-1.5 text-sm font-medium text-graphite">{T.doc.kb}</h2>
              <ul className="flex flex-col gap-1.5">
                {kbs.map((k) => (
                  <li key={k.id}>
                    <button
                      onClick={() => onKb(k.id)}
                      aria-current={k.id === kbId ? "true" : undefined}
                      className={`flex min-h-12 w-full items-center rounded-[10px] border px-3.5 py-2 text-start text-base ${k.id === kbId ? "border-primary border-s-[3px] bg-primary-soft font-semibold" : "border-edge active:bg-mist"}`}
                    >
                      <bdi>{k.name}</bdi>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="pt-5">
            <h2 className="px-4 pb-1 text-sm font-medium text-graphite">{kbs.length > 1 ? T.doc.recentHere : T.home.recent}</h2>
            <ul className="px-2">
              {recent.length === 0 && <li className="px-2 py-3 text-[15px] text-graphite">{T.home.noRecent}</li>}
              {recent.map((c) => (
                <li key={c.id} className="flex items-center">
                  <button
                    onClick={() => onOpen(c)}
                    aria-current={c.id === currentId ? "true" : undefined}
                    className={`flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-start active:bg-mist ${c.id === currentId ? "border-s-[3px] border-primary bg-mist" : ""}`}
                  >
                    {showStatus && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[c.mode]}`} />}
                    <span className="min-w-0 flex-1">
                      <bdi className={`block truncate text-base ${c.id === currentId ? "font-semibold" : ""}`}>{c.title ?? T.header.newCase}</bdi>
                      <span className="block text-[13px] text-stone">
                        {showStatus && <span>{T.caseStatus[c.mode]} · </span>}
                        <span>{timeLabel(c.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                  <button onClick={() => onDelete(c)} className="h-12 shrink-0 rounded-xl px-3 text-sm text-graphite active:bg-mist">
                    {T.header.deleteCase}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="shrink-0 border-t border-rule px-4 py-3">
          <p className="pb-2 text-[13px] leading-5 text-stone">{T.home.footer}</p>
          <nav aria-label={T.doc.menu} className="flex gap-5 text-sm">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="py-1.5 underline decoration-stone underline-offset-4">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

const noSubscribe = () => () => {};

function Composer({
  placeholder,
  text,
  onText,
  staged,
  onUnstage,
  busy,
  disabled,
  canAttach,
  attachOpen,
  onAttachOpen,
  onSend,
  onPhotos,
  onVideo,
  onCancel,
  onMicBlocked,
}: {
  placeholder: string;
  text: string;
  onText: (t: string) => void;
  staged: Staged | null;
  onUnstage: () => void;
  busy: boolean;
  disabled: boolean;
  canAttach: boolean;
  attachOpen: boolean;
  onAttachOpen: (open: boolean) => void;
  onSend: () => void;
  onPhotos: (f: File[]) => void;
  onVideo: (f: File[]) => void;
  onCancel: () => void;
  onMicBlocked: () => void;
}) {
  const canSend = !busy && !disabled && (text.trim().length > 0 || staged !== null);
  // Dictation: known only in the browser, so it is read after the first render.
  const dictation = useSyncExternalStore(noSubscribe, canDictate, () => false);
  const [listening, setListening] = useState(false);
  const stopDictation = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDictation.current?.(), []);
  const dictate = () => {
    const stop = startDictation({
      onText: onText,
      onEnd: () => (setListening(false), (stopDictation.current = null)),
      onBlocked: onMicBlocked,
    });
    if (!stop) return;
    stopDictation.current = stop;
    setListening(true);
  };
  const label = listening ? T.composer.listening : staged ? T.composer.askAboutPhoto : placeholder;
  return (
    <form
      aria-label={T.doc.placeholder}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
      className="relative"
    >
      {attachOpen && !disabled && (
        <div className="anim-rise absolute bottom-[calc(100%+8px)] start-0 z-10 flex w-56 flex-col overflow-hidden rounded-2xl border border-edge bg-paper shadow-[0_8px_24px_rgba(18,18,18,0.12)]">
          <FilePicker accept="image/*" multiple onFiles={(f) => (onAttachOpen(false), onPhotos(f))} className="flex h-14 items-center gap-3 px-4 text-[17px] active:bg-mist">
            <CameraIcon />
            <span>{T.composer.photo}</span>
          </FilePicker>
          <FilePicker accept="video/*" onFiles={(f) => (onAttachOpen(false), onVideo(f))} className="flex h-14 items-center gap-3 border-t border-rule px-4 text-[17px] active:bg-mist">
            <VideoIcon />
            <span>{T.composer.video}</span>
          </FilePicker>
        </div>
      )}

      {staged && (
        <div className="flex items-center gap-2 pb-2">
          <ul className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
            {staged.frames.map((f, i) => (
              <li key={i} className="shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
                <img src={f} alt={T.chat.sentPhoto} className="h-16 w-16 rounded-xl border border-edge object-cover" />
              </li>
            ))}
          </ul>
          <button type="button" onClick={onUnstage} aria-label={T.composer.removeAttachment} className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-edge active:bg-mist">
            <CloseIcon />
          </button>
        </div>
      )}

      {/* One white field: attach inside it, the camera, and a square send button. */}
      <div className="flex min-h-[54px] items-center gap-1 rounded-[12px] border border-edge bg-paper pe-1.5 ps-1 focus-within:border-primary focus-within:shadow-[0_0_0_1px_var(--color-primary)]">
        {canAttach && (
          <button
            type="button"
            onClick={() => onAttachOpen(!attachOpen)}
            disabled={disabled}
            aria-label={T.composer.attach}
            aria-expanded={attachOpen}
            className="grid h-12 w-11 shrink-0 place-items-center rounded-[8px] text-graphite active:bg-mist disabled:text-pebble"
          >
            <PlusIcon className={`transition-transform ${attachOpen ? "rotate-45" : ""}`} />
          </button>
        )}
        <label htmlFor="composer-text" className="sr-only">
          {label}
        </label>
        <input
          id="composer-text"
          value={text}
          onChange={(e) => onText(e.target.value)}
          maxLength={500}
          disabled={disabled}
          enterKeyHint="send"
          autoComplete="off"
          placeholder={label}
          className={`focus-in-box h-12 min-w-0 flex-1 bg-transparent text-[16px] placeholder:text-stone ${canAttach ? "" : "ps-3"}`}
        />
        {busy ? (
          <button type="button" onClick={onCancel} aria-label={T.composer.stop} className="grid h-11 w-11 shrink-0 place-items-center rounded-[9px] bg-action">
            <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] bg-white" />
          </button>
        ) : listening ? (
          <button type="button" onClick={() => stopDictation.current?.()} aria-label={T.composer.dictateStop} className="grid h-11 w-11 shrink-0 place-items-center rounded-[9px] bg-danger text-white">
            <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] bg-white" />
          </button>
        ) : canSend || !dictation ? (
          <button type="submit" disabled={!canSend} aria-label={T.composer.send} className="grid h-11 w-11 shrink-0 place-items-center rounded-[9px] bg-action text-white disabled:bg-rule-soft disabled:text-pebble">
            <SendIcon className="h-5 w-5" />
          </button>
        ) : (
          // Nothing typed: the button records. The words land in the box, ready to send or fix.
          <button type="button" onClick={dictate} disabled={disabled} aria-label={T.composer.dictate} className="grid h-11 w-11 shrink-0 place-items-center rounded-[9px] text-graphite active:bg-mist disabled:text-pebble">
            <MicIcon />
          </button>
        )}
      </div>
    </form>
  );
}

// Shown when the server asks for an access code (ACCESS_CODE is set and this phone has none).
function AccessCode({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    const res = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) onDone();
    else setProblem(!res ? T.doc.access.offline : res.status === 429 ? T.doc.access.tooMany : T.doc.access.wrong);
  };
  return (
    <main className="tech mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-5 py-8">
      <h1 className="pb-2">
        <Logo size={44} tagline />
      </h1>
      <p className="text-[17px] leading-[26px] text-graphite">{T.doc.access.lead}</p>
      <form onSubmit={submit} className="flex flex-col gap-3 pt-2">
        <label htmlFor="access-code" className="text-base font-medium">
          {T.doc.access.code}
        </label>
        <input
          id="access-code"
          value={code}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          dir="ltr"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "access-problem" : undefined}
          onChange={(e) => (setCode(e.target.value), setProblem(null))}
          className="h-14 rounded-[16px] border border-edge bg-paper px-4 text-center font-mono text-xl tracking-widest focus:border-primary"
        />
        {problem && (
          <p id="access-problem" role="alert" className="text-base text-danger-ink">
            {problem}
          </p>
        )}
        <button disabled={busy} className="h-14 rounded-[16px] bg-action text-[17px] font-medium text-white disabled:opacity-60">
          {T.doc.access.submit}
        </button>
      </form>
      <p className="text-[15px] leading-[22px] text-graphite">{T.doc.access.help}</p>
      <nav aria-label={T.doc.menu} className="flex gap-5 pt-4 text-sm">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="py-1.5 underline decoration-stone underline-offset-4">
            {l.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}

// A full-screen notice with one action: nothing can be done until it is resolved.
function Notice({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <main className="tech mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-5">
      <h1 className="pb-1">
        <Logo size={40} />
      </h1>
      <p role="alert" className="text-[19px] leading-7">
        {text}
      </p>
      {action && (
        <button onClick={onAction} className="h-14 rounded-[16px] bg-action text-[17px] font-medium text-white">
          {action}
        </button>
      )}
    </main>
  );
}

// A round icon button in the top bar, as in any messaging app. The label is read by a screen reader.
// The machines this technician can ask about, opened from the bar. Shown only when there is
// more than one; a tap outside or Escape closes it.
function Machines({ kbs, kbId, onPick, onClose }: { kbs: KbSummary[]; kbId: string; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useDialog(onClose);
  return (
    <>
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-30" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={T.doc.switchKb} className="anim-rise absolute inset-x-2 top-[calc(100%+4px)] z-40 overflow-hidden rounded-[12px] border border-edge bg-paper shadow-[0_8px_24px_rgba(18,18,18,0.14)]">
        <ul className="max-h-[60dvh] overflow-y-auto py-1">
          {kbs.map((k) => (
            <li key={k.id}>
              <button onClick={() => onPick(k.id)} aria-current={k.id === kbId ? "true" : undefined} className={`flex min-h-12 w-full items-center gap-3 px-4 text-start text-[16px] active:bg-mist ${k.id === kbId ? "font-semibold" : ""}`}>
                <bdi className="min-w-0 flex-1 truncate">{k.name}</bdi>
                {k.id === kbId && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function HeaderButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} className="grid h-12 w-11 shrink-0 place-items-center rounded-full text-ink active:bg-mist disabled:opacity-40">
      {children}
    </button>
  );
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return T.doc.today;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return T.doc.yesterday;
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "long" });
}

const speechSupported = () => {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
};

export function TechnicianApp() {
  const raw = useSyncExternalStore(subscribeConversations, conversationsSnapshot, () => "[]");
  // Removed conversations stay on the phone (soft delete) but are not shown.
  const all = useMemo(() => visibleConversations(parseConversations(raw)), [raw]);
  // null: loading. "error": the server could not be reached.
  const [kbs, setKbs] = useState<KbSummary[] | "error" | null>(null);
  const [kbId, setKbId] = useState("");
  const [locked, setLocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const list = Array.isArray(kbs) ? kbs : [];
  const kb = list.find((k) => k.id === kbId);
  const isDocs = kb?.kind !== "trees";
  const recent = useMemo(() => all.filter((c) => c.kbId === kbId), [all, kbId]);
  const kbRef = useRef(kbId);
  const docsRef = useRef(isDocs);
  useEffect(() => {
    kbRef.current = kbId;
    docsRef.current = isDocs;
  });

  // The knowledge bases come from the server; the last one used is remembered on this phone.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/kbs")
      .then((r) => {
        if (r.status === 401) throw new HttpError(401);
        if (!r.ok) throw new HttpError(r.status);
        return r.json();
      })
      .then((data: { kbs: KbSummary[] }) => {
        if (cancelled) return;
        const wanted = new URLSearchParams(window.location.search).get("kb") ?? selectedKb();
        setKbs(data.kbs);
        setKbId(data.kbs.find((k) => k.id === wanted)?.id ?? data.kbs[0]?.id ?? "");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof HttpError && e.status === 401) setLocked(true);
        else setKbs("error");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const [active, setActive] = useState<Active>(() => ({
    // The id is given on the first send: no clock or random value while prerendering.
    conversation: { id: "", kbId: "", events: [], mode: "identify", updatedAt: 0 },
    screen: EMPTY,
  }));
  const [draft, setDraft] = useState("");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  // The answer while the server is still writing it: verified steps, one after another.
  const [live, setLive] = useState<PartialAnswer | null>(null);
  const [animateFrom, setAnimateFrom] = useState(Number.MAX_SAFE_INTEGER);
  // The newest answer was already shown step by step, so it is not typed out again.
  const [streamed, setStreamed] = useState(false);
  const [maps, setMaps] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // The list of machines under the bar (only when there is more than one).
  const [machines, setMachines] = useState(false);
  const [call, setCall] = useState<"voice" | "video" | null>(null);
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  }, [call]);
  const [speech, setSpeech] = useState<Speech>({ id: 0, part: 0, lines: [], answer: 0 });
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });

  // Live chat: stay pinned to the newest line while messages type out and grow, unless the
  // technician has scrolled up to read.
  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const ready = Array.isArray(kbs) && kbs.length > 0 && !locked;
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    const follow = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    follow.observe(inner); // messages typing out
    follow.observe(el); // the chat area changing size
    return () => {
      el.removeEventListener("scroll", onScroll);
      follow.disconnect();
    };
  }, [ready]);
  useEffect(() => {
    pinned.current = true;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [active, pending, progress, maps, live]);

  const fresh = (forKb = kbRef.current): Active => ({
    conversation: { id: newConversationId(), kbId: forKb, events: [], mode: "identify", updatedAt: Date.now() },
    screen: EMPTY,
  });

  const open = (base: Active) => {
    abort.current?.abort();
    setActive(base);
    setMaps([]);
    setAnimateFrom(Number.MAX_SAFE_INTEGER);
    setError(null);
    setMenu(false);
    setAttachOpen(false);
  };

  // Returns the server's reply (and where its new items start), or null. On failure nothing the
  // technician wrote is lost: the caller puts it back in the question box.
  const send = useCallback(async (base: Active, input: Input, sent?: Pending, speak = false): Promise<(Reply & { from: number }) | null> => {
    setBusy(true);
    setError(null);
    setPending(sent ?? null);
    setProgress([]);
    setLive(null);
    let streamed = false;
    const sentAt = Date.now();
    // In a call the answer is spoken as it is written: each verified step when it arrives, then
    // whatever the finished answer adds. No filler line while it is being looked up.
    const said = new Set<string>();
    const sayMore = (lines: string[], finished = false) => {
      const fresh = lines.filter((l) => !said.has(l));
      fresh.forEach((l) => said.add(l));
      if (fresh.length || finished) setSpeech((s) => ({ ...s, part: s.part + 1, lines: fresh, answer: s.answer + (finished ? 1 : 0) }));
    };
    if (speak && input.kind !== "view") setSpeech((s) => ({ id: s.id + 1, part: 0, lines: [], answer: s.answer }));
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await post(
        base.conversation.kbId || kbRef.current,
        base.conversation.events,
        input,
        { conversationId: base.conversation.id, channel: callRef.current ?? "chat" },
        // The same stage reported twice in a row is one line.
        (p) => setProgress((steps) => (steps.at(-1)?.key === p ? steps : [...steps.map((s) => ({ ...s, done: true })), { key: p, done: false }])),
        (p) => {
          streamed = true;
          setLive(p);
          if (speak) sayMore(partialSpeech(p));
        },
        controller.signal,
      );
      let media = base.conversation.media;
      let times = base.conversation.times;
      if (res.events.length > base.conversation.events.length) {
        times = { ...times, [res.events.length - 1]: sentAt };
        if (sent?.frames?.length) media = { ...media, [res.events.length - 1]: await Promise.all(sent.frames.map((f) => thumbnail(f))) };
      }
      const conversation = {
        ...base.conversation,
        id: base.conversation.id || newConversationId(),
        kbId: base.conversation.kbId || kbRef.current,
        events: res.events,
        media,
        times,
        title: res.screen.title ?? base.conversation.title,
        mode: res.screen.mode,
        updatedAt: Date.now(),
      };
      if (res.events.length) saveConversation(conversation);
      const from = base.screen.items.length;
      setAnimateFrom(input.kind === "view" ? Number.MAX_SAFE_INTEGER : from);
      setStreamed(streamed);
      setActive({ conversation, screen: res.screen });
      if (speak) sayMore(speechFor(res.screen, from), true);
      return { ...res, from };
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) setLocked(true);
      else if ((e as Error).name === "AbortError") return null;
      else if (input.kind === "view") setError(T.doc.openError);
      else setError(e instanceof HttpError && e.status === 429 ? T.doc.rateLimited : e instanceof HttpError || e instanceof TypeError ? T.composer.error : T.doc.error);
      return null;
    } finally {
      setBusy(false);
      setPending(null);
      setProgress([]);
      setLive(null);
    }
  }, []);

  // A finished conversation starts a new case with whatever is sent next.
  const target = (a: Active) => (a.screen.mode === "done" || a.screen.mode === "ended" ? fresh() : a);

  // One message: text, attached photos or video frames, or both.
  const sendMessage = useCallback(
    async (text: string, attachment: Staged | null, speak = false) => {
      if (!text && !attachment) return null;
      const base = target(activeRef.current);
      if (base !== activeRef.current) open(base);
      const media = attachment ? { images: attachment.frames.map(dataUrlToImage), media: attachment.media } : {};
      const input: Input = docsRef.current
        ? { kind: "ask", ...(text ? { text } : {}), ...media }
        : base.screen.mode === "identify" || attachment
          ? { kind: "describe", ...(text ? { text } : {}), ...media }
          : { kind: "text", text, symptomId: base.screen.current?.symptomId };
      return send(base, input, { said: text || undefined, frames: attachment?.frames, at: new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) }, speak);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest state through activeRef
    [send],
  );

  const submit = async () => {
    const text = draft.trim();
    const attachment = staged;
    setDraft("");
    setStaged(null);
    setAttachOpen(false);
    const ok = await sendMessage(text, attachment);
    if (!ok) {
      // Put the question back, unless the technician already started a new one.
      setDraft((now) => now || text);
      setStaged((now) => now ?? attachment);
      setError((e) => (e && text ? `${e} ${T.composer.notSent}` : e));
    }
  };

  const stagePhotos = async (files: File[]) => {
    setError(files.length > MAX_PHOTOS ? T.composer.maxPhotos : null);
    try {
      const frames = await Promise.all(files.slice(0, MAX_PHOTOS).map(photoToDataUrl));
      setStaged({ frames, media: "photo" });
      document.getElementById("composer-text")?.focus();
    } catch {
      setError(T.composer.photoError);
    }
  };

  const stageVideo = async (files: File[]) => {
    setError(null);
    try {
      setStaged({ frames: await videoToDataUrls(files[0]), media: "video" });
      document.getElementById("composer-text")?.focus();
    } catch {
      setError(T.composer.videoError);
    }
  };

  const startCall = (kind: "voice" | "video") => {
    if (!speechSupported()) return setError(T.call.unsupported);
    const base = target(active);
    if (base !== active) open(base);
    const lines = base.screen.items.length ? resumeSpeech(base.screen) : [T.call.greeting];
    // Inside the tap that starts the call, so the phone lets the assistant speak later.
    voicePlayer().unlock();
    if (isDocs) primeLiveAudio();
    setSpeech((s) => ({ id: s.id + 1, part: 0, lines, answer: s.answer + 1 }));
    setCall(kind);
  };

  const { screen, conversation } = active;
  const first = conversation.events[0];
  const mapFrom = first?.type === "IDENTIFY_RESULT" && first.media ? first.media : "text";
  const noDocuments = isDocs && kb !== undefined && kb.documents === 0;
  // The standing notice, at the top of every conversation.
  const notice = isDocs ? T.doc.disclaimer : T.disclaimer;
  const empty = screen.items.length === 0 && !pending && !opening && !live;
  const canAttach = isDocs || screen.mode === "identify" || screen.mode === "done" || screen.mode === "ended";

  const switchKb = (id: string) => {
    selectKb(id);
    setKbId(id);
    open(fresh(id));
  };

  const openSaved = async (c: SavedConversation) => {
    const base = { conversation: c, screen: EMPTY };
    open(base);
    setOpening(true);
    await send(base, { kind: "view" });
    setOpening(false);
  };

  // In a call, the newest answer that points at something in the technician's picture.
  const lastItem = screen.items.at(-1);
  const callVisual =
    lastItem?.kind === "doc_answer" && lastItem.marks.length && conversation.media?.[lastItem.eventIndex]
      ? { frames: conversation.media[lastItem.eventIndex], marks: lastItem.marks }
      : undefined;

  if (locked) return <AccessCode onDone={() => window.location.reload()} />;
  if (kbs === "error") return <Notice text={T.doc.loadError} action={T.doc.retry} onAction={() => (setKbs(null), setAttempt((n) => n + 1))} />;
  if (kbs === null) return <main className="tech grid min-h-dvh place-items-center text-[17px] text-graphite">{T.doc.loading}</main>;
  if (kbs.length === 0) return <Notice text={T.doc.noKbs} />;

  return (
    <div className="tech mx-auto flex h-dvh max-w-md flex-col bg-canvas">
      {/* A quiet bar, as in the chat apps people know: the menu, which machine, and the two
          ways to call. No logo here: the screen is the conversation. */}
      <header className="relative flex h-14 shrink-0 items-center border-b border-rule-soft bg-bar pe-1 ps-1">
        <HeaderButton label={T.doc.menu} onClick={() => setMenu(true)}>
          <MenuIcon />
        </HeaderButton>
        <div className="min-w-0 flex-1 px-1">
          {list.length > 1 ? (
            <button
              onClick={() => setMachines((m) => !m)}
              aria-expanded={machines}
              aria-label={`${T.doc.switchKb}: ${kb?.name ?? ""}`}
              className="flex h-12 max-w-full items-center gap-1.5 rounded-[8px] px-2 text-[15px] font-medium active:bg-mist"
            >
              <bdi className="min-w-0 truncate">{kb?.name ?? T.appTitle}</bdi>
              <ArrowIcon className={`h-3.5 w-3.5 shrink-0 text-stone transition-transform ${machines ? "-rotate-90" : "rotate-90"}`} />
            </button>
          ) : (
            // One machine: nothing to choose, so it is only a small name.
            <p className="truncate px-2 text-[13px] text-stone">
              <bdi>{kb?.name ?? T.appTitle}</bdi>
              {screen.title && !isDocs && <span> · {screen.title}</span>}
            </p>
          )}
        </div>
        {screen.candidates.length > 0 && (
          <HeaderButton label={T.header.map} onClick={() => setMaps((m) => [...m, screen.items.length])} disabled={busy}>
            <MapIcon />
          </HeaderButton>
        )}
        {isDocs && (
          <>
            <HeaderButton label={T.doc.videoCall} onClick={() => startCall("video")} disabled={busy || noDocuments}>
              <VideoIcon />
            </HeaderButton>
            <HeaderButton label={T.doc.voiceCall} onClick={() => startCall("voice")} disabled={busy || noDocuments}>
              <PhoneIcon />
            </HeaderButton>
          </>
        )}
        {machines && <Machines kbs={list} kbId={kbId} onPick={(id) => (setMachines(false), switchKb(id))} onClose={() => setMachines(false)} />}
      </header>

      <main ref={scroller} className="flex flex-1 flex-col overflow-y-auto px-2.5 pb-3 pt-3">
        <div ref={content} className="mt-auto">
          {opening ? (
            <p role="status" className="pb-10 text-center text-[17px] text-graphite">
              {T.doc.opening}
            </p>
          ) : empty ? (
            // A new conversation: one question, and three ways to start without typing.
            <div className="flex flex-col px-3 pb-3">
              <h2 className="text-[28px] font-extrabold leading-[34px] tracking-[-0.035em]">{noDocuments ? T.doc.empty : isDocs ? T.doc.emptyTitle : T.chat.emptyLead}</h2>
              {isDocs && !noDocuments && (
                <ul className="pt-5">
                  {T.doc.emptyIdeas.map((idea) => (
                    <li key={idea} className="border-b border-rule-soft">
                      <button onClick={() => void sendMessage(idea, null)} className="flex min-h-12 w-full items-center justify-between gap-3 text-start text-[16px] text-graphite active:bg-mist">
                        <span>{idea}</span>
                        <ArrowIcon className="h-4 w-4 shrink-0 rotate-180 text-pebble" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="pt-4 text-[13px] leading-5 text-stone">{notice}</p>
            </div>
          ) : (
            <ChatView
              screen={screen}
              media={conversation.media ?? {}}
              animateFrom={animateFrom}
              streamed={streamed}
              live={call ? null : live}
              maps={maps}
              mapFrom={mapFrom}
              times={conversation.times}
              paired={isDocs}
              day={conversation.times?.[0] ? dayLabel(conversation.times[0]) : undefined}
              notice={notice}
              progress={call ? [] : progress}
              pending={
                pending && (
                  <div className="anim-rise flex flex-col items-start gap-1.5 pt-1.5">
                    {pending.frames?.[0] && (
                      // eslint-disable-next-line @next/next/no-img-element -- local data URL
                      <img src={pending.frames[0]} alt={T.chat.sentPhoto} className="w-[62%] rounded-[12px] rounded-ss-[3px] border-[3px] border-bubble" />
                    )}
                    {pending.said && (
                      <div className="own max-w-[85%] rounded-[12px] rounded-ss-[3px] bg-bubble px-3.5 py-2.5 text-[16px] leading-[25px] text-ink-soft">
                        {pending.said}
                        <ChatTime at={pending.at} />
                      </div>
                    )}
                  </div>
                )
              }
              kbId={conversation.kbId || kbId}
              onOption={(text) => void sendMessage(text, null)}
              onPick={(symptomId) => send(active, { kind: "pick", symptomId })}
              onOther={() => document.getElementById("composer-text")?.focus()}
              onAttach={() => setAttachOpen(true)}
              onAck={(symptomId) => send(active, { kind: "acknowledge", symptomId }, { said: T.stop.acknowledged })}
            />
          )}
          {error && (
            <p role="alert" className="mt-3 rounded-xl border border-danger bg-paper px-3.5 py-3 text-base leading-6 text-danger-ink">
              {error}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </main>

      <div className="bg-bar px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-2">
        <Composer
          placeholder={isDocs ? T.doc.placeholder : screen.mode === "identify" ? T.composer.describe : T.composer.answer}
          text={draft}
          onText={setDraft}
          staged={canAttach ? staged : null}
          onUnstage={() => setStaged(null)}
          busy={busy}
          disabled={noDocuments}
          canAttach={canAttach}
          attachOpen={attachOpen && canAttach}
          onAttachOpen={setAttachOpen}
          onSend={submit}
          onPhotos={stagePhotos}
          onVideo={stageVideo}
          onCancel={() => abort.current?.abort()}
          onMicBlocked={() => setError(T.call.noMic)}
        />
      </div>

      {menu && (
        <Menu
          kbs={list}
          kbId={kbId}
          showStatus={!isDocs}
          onKb={switchKb}
          recent={recent}
          currentId={conversation.id}
          onOpen={openSaved}
          onNew={() => open(fresh())}
          onDelete={(c) => {
            if (!window.confirm(T.header.confirmDelete)) return;
            deleteConversation(c.id);
            // The environment's log marks it as removed by the technician; nothing is erased.
            void fetch("/api/conversations/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: c.id }) }).catch(() => {});
            if (c.id === conversation.id) open(fresh());
          }}
          onClose={() => setMenu(false)}
        />
      )}

      {call && (
        <CallView
          kind={call}
          kbId={conversation.kbId || kbId}
          conversationId={conversation.id}
          kbName={kb?.name ?? T.appTitle}
          disclaimer={isDocs ? T.doc.disclaimer : T.disclaimer}
          title={screen.title ?? T.appTitle}
          screen={screen}
          speech={speech}
          busy={busy}
          progress={progress.at(-1)?.key}
          visual={callVisual}
          onUtterance={(text, frame) => void sendMessage(text, frame ? { frames: [frame], media: "photo" } : null, true)}
          // The live model's one tool: the same verified answer engine as the chat. The answer
          // lands in the chat with its sources; the model gets only what the chat shows.
          onLiveAsk={
            isDocs
              ? async (question, frame) => {
                  const reply = await sendMessage(question, frame ? { frames: [frame], media: "photo" } : null, false);
                  return reply ? liveToolResult(reply.screen, reply.from) : { kind: "error", note: T.doc.error };
                }
              : undefined
          }
          onAck={(symptomId) => send(activeRef.current, { kind: "acknowledge", symptomId }, { said: T.stop.acknowledged }, true)}
          onHangUp={() => {
            voicePlayer().stop();
            setCall(null);
          }}
        />
      )}
    </div>
  );
}
