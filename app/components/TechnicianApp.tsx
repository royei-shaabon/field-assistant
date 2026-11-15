"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientInput, Progress } from "@/lib/conversation";
import type { DocInput } from "@/lib/docs/conversation";
import type { Screen } from "@/lib/screen";
import type { KbSummary } from "@/lib/server/kbs";
import { resumeSpeech, speechFor } from "@/lib/speech";
import { dataUrlToImage, photoToDataUrl, thumbnail, videoToDataUrls } from "@/lib/client/image";
import {
  conversationsSnapshot,
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
import { ChatView, chatTypingMs, type ProgressStep } from "./Chat";
import { CameraIcon, CloseIcon, MapIcon, MenuIcon, PhoneIcon, PlusIcon, SendIcon, VideoIcon } from "./icons";

const EMPTY: Screen = { items: [], mode: "identify", candidates: [], trees: [], danger: false };

type Active = { conversation: SavedConversation; screen: Screen };
type Input = ClientInput | DocInput;
type Reply = { events: SavedConversation["events"]; screen: Screen };
type Pending = { said?: string; frames?: string[] };

// Reads the NDJSON stream from /api/conversation: progress lines, then the result.
async function post(
  kbId: string,
  events: SavedConversation["events"],
  input: Input,
  onProgress: (p: Progress, detail?: string) => void,
  signal: AbortSignal,
): Promise<Reply> {
  const res = await fetch("/api/conversation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kbId, events, input }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
      const msg = JSON.parse(line) as { progress?: Progress; detail?: string; result?: Reply; error?: string };
      if (msg.progress) onProgress(msg.progress, msg.detail);
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

function Cases({
  kbs,
  kbId,
  showStatus,
  onKb,
  recent,
  currentId,
  onOpen,
  onNew,
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
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 mx-auto flex max-w-md">
      <button aria-label={T.header.close} onClick={onClose} className="absolute inset-0 bg-ink/40" />
      <nav aria-label={T.header.cases} className="anim-rise relative flex w-[82%] flex-col bg-paper shadow-[0_0_32px_rgba(18,18,18,0.18)]">
        <div className="flex h-[60px] items-center justify-between pe-2 ps-4">
          <div className="flex items-center gap-2">
            <span aria-hidden className="grid h-7 w-7 place-items-center rounded-lg bg-ink">
              <span className="h-2.5 w-2.5 rounded-[3px] bg-signal" />
            </span>
            <span className="text-[17px] font-semibold">{T.appTitle}</span>
          </div>
          <button onClick={onClose} aria-label={T.header.close} className="grid h-11 w-11 place-items-center">
            <CloseIcon />
          </button>
        </div>
        {kbs.length > 1 && (
          <div className="px-3 pb-3">
            <label htmlFor="kb-select" className="block px-1 pb-1 text-[13px] font-medium text-stone">
              {T.doc.kb}
            </label>
            <select
              id="kb-select"
              value={kbId}
              onChange={(e) => onKb(e.target.value)}
              className="h-12 w-full rounded-[14px] border border-rule bg-paper px-3 text-base"
            >
              {kbs.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="px-3">
          <button onClick={onNew} className="flex h-12 w-full items-center gap-3 rounded-[14px] bg-mist px-3.5 text-base font-medium">
            <PlusIcon />
            <span>{T.header.newCase}</span>
          </button>
        </div>
        <h2 className="px-4 pb-1 pt-5 text-[13px] font-medium text-stone">{T.home.recent}</h2>
        <ul className="flex-1 overflow-y-auto px-2">
          {recent.length === 0 && <li className="px-2 py-3 text-sm text-stone">{T.home.noRecent}</li>}
          {recent.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => onOpen(c)}
                className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-3 text-start ${c.id === currentId ? "bg-mist" : "active:bg-mist"}`}
              >
                {showStatus && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[c.mode]}`} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">{c.title ?? T.header.newCase}</span>
                  {showStatus && <span className="block text-xs text-stone">{T.caseStatus[c.mode]}</span>}
                </span>
                <span className="font-mono text-[11px] text-stone">{timeLabel(c.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="px-4 pb-4 text-[11px] text-stone">{T.home.footer}</p>
      </nav>
    </div>
  );
}

function Composer({
  placeholder,
  canAttach,
  busy,
  onSend,
  onPhotos,
  onVideo,
  onCancel,
}: {
  placeholder: string;
  canAttach: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onPhotos: (f: File[]) => void;
  onVideo: (f: File[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t);
  };
  return (
    <div className="relative">
      {attach && canAttach && !busy && (
        <div className="anim-rise absolute bottom-[64px] start-0 flex flex-col overflow-hidden rounded-2xl border border-rule bg-paper shadow-[0_8px_24px_rgba(18,18,18,0.08)]">
          <FilePicker accept="image/*" multiple onFiles={(f) => (setAttach(false), onPhotos(f))} className="flex h-12 items-center gap-3 px-4 text-base active:bg-mist">
            <CameraIcon />
            <span>{T.composer.photo}</span>
          </FilePicker>
          <FilePicker accept="video/*" onFiles={(f) => (setAttach(false), onVideo(f))} className="flex h-12 items-center gap-3 border-t border-rule-soft px-4 text-base active:bg-mist">
            <VideoIcon />
            <span>{T.composer.video}</span>
          </FilePicker>
        </div>
      )}
      <div className="flex min-h-14 items-center gap-1 rounded-[22px] bg-mist pe-2 ps-1.5">
        {canAttach && (
          <button
            onClick={() => setAttach((a) => !a)}
            disabled={busy}
            aria-label={T.composer.attach}
            aria-expanded={attach}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink disabled:text-[#b4b4ae]"
          >
            <PlusIcon className={`h-[22px] w-[22px] transition-transform ${attach ? "rotate-45" : ""}`} />
          </button>
        )}
        <label htmlFor="composer-text" className="sr-only">
          {T.composer.answer}
        </label>
        <input
          id="composer-text"
          value={busy ? "" : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          maxLength={500}
          disabled={busy}
          placeholder={busy ? T.composer.writing : placeholder}
          className={`h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-pebble ${canAttach ? "" : "ps-2.5"}`}
        />
        {busy ? (
          <button onClick={onCancel} aria-label={T.composer.writing} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink">
            <span className="h-3 w-3 rounded-[3px] bg-white" />
          </button>
        ) : (
          <button onClick={send} disabled={!text.trim()} aria-label={T.composer.send} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink text-white disabled:bg-[#d6d6d1]">
            <SendIcon className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
    </div>
  );
}

// Shown when the server asks for an access code (ACCESS_CODE is set and this phone has none).
function AccessCode({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) onDone();
    else setWrong(true);
  };
  return (
    <main className="mx-auto flex h-dvh max-w-sm flex-col justify-center gap-4 px-5">
      <span aria-hidden className="grid h-12 w-12 place-items-center rounded-2xl bg-ink">
        <span className="h-4 w-4 rounded-[5px] bg-signal" />
      </span>
      <h1 className="text-2xl font-semibold">{T.doc.access.title}</h1>
      <p className="text-[15px] leading-[22px] text-graphite">{T.doc.access.lead}</p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label htmlFor="access-code" className="sr-only">
          {T.doc.access.code}
        </label>
        <input
          id="access-code"
          value={code}
          autoComplete="off"
          onChange={(e) => (setCode(e.target.value), setWrong(false))}
          placeholder={T.doc.access.code}
          className="h-14 rounded-[16px] border border-rule bg-paper px-4 text-center font-mono text-xl tracking-widest outline-none focus:border-ink"
        />
        {wrong && <p className="text-sm text-danger-ink">{T.doc.access.wrong}</p>}
        <button disabled={busy || !code.trim()} className="h-12 rounded-[14px] bg-ink text-base font-medium text-white disabled:opacity-40">
          {T.doc.access.submit}
        </button>
      </form>
    </main>
  );
}

export function TechnicianApp() {
  const raw = useSyncExternalStore(subscribeConversations, conversationsSnapshot, () => "[]");
  const all = useMemo(() => parseConversations(raw), [raw]);
  const [kbs, setKbs] = useState<KbSummary[] | null>(null);
  const [kbId, setKbId] = useState("");
  const [locked, setLocked] = useState(false);
  const kb = kbs?.find((k) => k.id === kbId);
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
        if (r.status === 401) throw new Error("access_code");
        return r.json();
      })
      .then((data: { kbs: KbSummary[] }) => {
        if (cancelled) return;
        const wanted = new URLSearchParams(window.location.search).get("kb") ?? selectedKb();
        setKbs(data.kbs);
        setKbId(data.kbs.find((k) => k.id === wanted)?.id ?? data.kbs[0]?.id ?? "");
      })
      .catch((e: Error) => !cancelled && (e.message === "access_code" ? setLocked(true) : setKbs([])));
    return () => {
      cancelled = true;
    };
  }, []);
  const [active, setActive] = useState<Active>(() => ({
    // The id is given on the first send: no clock or random value while prerendering.
    conversation: { id: "", kbId: "", events: [], mode: "identify", updatedAt: 0 },
    screen: EMPTY,
  }));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [animateFrom, setAnimateFrom] = useState(Number.MAX_SAFE_INTEGER);
  const [typing, setTyping] = useState(false);
  const [maps, setMaps] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [call, setCall] = useState<"voice" | "video" | null>(null);
  const [speech, setSpeech] = useState<Speech>({ id: 0, lines: [] });
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
  }, []);
  useEffect(() => {
    pinned.current = true;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [active, pending, progress, maps]);

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
    setDrawer(false);
  };

  const send = useCallback(async (base: Active, input: Input, sent?: Pending, speak = false) => {
    setBusy(true);
    setError(null);
    setPending(sent ?? null);
    setProgress([]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await post(
        base.conversation.kbId || kbRef.current,
        base.conversation.events,
        input,
        (p, detail) => setProgress((list) => [...list.map((s) => ({ ...s, done: true })), { key: p, done: false, detail }]),
        controller.signal,
      );
      let media = base.conversation.media;
      if (sent?.frames?.length && res.events.length > base.conversation.events.length) {
        media = { ...media, [res.events.length - 1]: await Promise.all(sent.frames.map((f) => thumbnail(f))) };
      }
      const conversation = {
        ...base.conversation,
        id: base.conversation.id || newConversationId(),
        kbId: base.conversation.kbId || kbRef.current,
        events: res.events,
        media,
        title: res.screen.title ?? base.conversation.title,
        mode: res.screen.mode,
        updatedAt: Date.now(),
      };
      saveConversation(conversation);
      const from = base.screen.items.length;
      setAnimateFrom(from);
      const ms = chatTypingMs(res.screen, from);
      setTyping(ms > 0);
      if (ms > 0) setTimeout(() => setTyping(false), ms + 150);
      setActive({ conversation, screen: res.screen });
      if (speak) setSpeech((s) => ({ id: s.id + 1, lines: speechFor(res.screen, from) }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(T.composer.error);
    } finally {
      setBusy(false);
      setPending(null);
      setProgress([]);
    }
  }, []);

  // A finished conversation starts a new case with whatever is sent next.
  const target = (a: Active) => (a.screen.mode === "done" || a.screen.mode === "ended" ? fresh() : a);

  const sendText = useCallback(
    (text: string, frame?: string, speak = false) => {
      const base = target(activeRef.current);
      if (base !== activeRef.current) open(base);
      const frames = frame ? [frame] : undefined;
      const media = frames ? { images: frames.map(dataUrlToImage), media: "photo" as const } : {};
      if (!text && !frames) return;
      const input: Input = docsRef.current
        ? { kind: "ask", ...(text ? { text } : {}), ...media }
        : base.screen.mode === "identify"
          ? { kind: "describe", ...(text ? { text } : {}), ...media }
          : { kind: "text", text: text || "?", symptomId: base.screen.current?.symptomId };
      void send(base, input, { said: text || undefined, frames }, speak);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest state through activeRef
    [send],
  );

  const sendPhotos = async (files: File[]) => {
    const base = target(active);
    if (base !== active) open(base);
    try {
      const frames = await Promise.all(files.slice(0, 4).map(photoToDataUrl));
      await send(base, { kind: isDocs ? "ask" : "describe", images: frames.map(dataUrlToImage), media: "photo" }, { frames });
    } catch {
      setError(T.composer.error);
    }
  };

  const sendVideo = async (files: File[]) => {
    const base = target(active);
    if (base !== active) open(base);
    try {
      const frames = await videoToDataUrls(files[0]);
      await send(base, { kind: isDocs ? "ask" : "describe", images: frames.map(dataUrlToImage), media: "video" }, { frames });
    } catch {
      setError(T.composer.videoError);
    }
  };

  const startCall = (kind: "voice" | "video") => {
    const base = target(active);
    if (base !== active) open(base);
    const lines = base.screen.items.length ? resumeSpeech(base.screen) : [T.call.greeting];
    setSpeech((s) => ({ id: s.id + 1, lines }));
    setCall(kind);
  };

  const { screen, conversation } = active;
  const first = conversation.events[0];
  const mapFrom = first?.type === "IDENTIFY_RESULT" && first.media ? first.media : "text";
  const empty = screen.items.length === 0 && !pending;
  const canAttach = screen.mode === "identify" || screen.mode === "done" || screen.mode === "ended";
  // In a call, the newest answer that points at something in the technician's picture.
  const lastItem = screen.items.at(-1);
  const callVisual =
    lastItem?.kind === "doc_answer" && lastItem.marks.length && conversation.media?.[lastItem.eventIndex]
      ? { frames: conversation.media[lastItem.eventIndex], marks: lastItem.marks }
      : undefined;
  const switchKb = (id: string) => {
    selectKb(id);
    setKbId(id);
    open(fresh(id));
  };
  const iconButton = "grid h-10 w-10 place-items-center rounded-full active:bg-mist disabled:opacity-40";

  if (locked) return <AccessCode onDone={() => window.location.reload()} />;

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-paper">
      <header className="flex h-[60px] shrink-0 items-center gap-1 px-1.5">
        <button onClick={() => setDrawer(true)} aria-label={T.header.cases} className="grid h-11 w-11 place-items-center">
          <MenuIcon className="h-[22px] w-[22px]" />
        </button>
        <div className="min-w-0 flex-1 leading-tight">
          <h1 className="truncate text-base font-semibold">{screen.title ?? T.appTitle}</h1>
          <p className="text-xs text-stone">
            <span>{kb?.name ?? (kbs ? T.appTitle : T.doc.loading)}</span>
            {conversation.events.length > 0 && (
              <>
                {" "}
                <span>·</span> <span>{timeLabel(conversation.updatedAt)}</span>
              </>
            )}
          </p>
        </div>
        {screen.candidates.length > 0 && (
          <button onClick={() => setMaps((m) => [...m, screen.items.length])} disabled={busy} aria-label={T.header.map} className={`relative ${iconButton}`}>
            <MapIcon />
            <span className="absolute end-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 font-mono text-[10px] text-white">{screen.candidates.length}</span>
          </button>
        )}
        <button onClick={() => startCall("voice")} disabled={busy} aria-label={T.call.voice} className={iconButton}>
          <PhoneIcon />
        </button>
        <button onClick={() => startCall("video")} disabled={busy} aria-label={T.call.video} className={`me-1 ${iconButton}`}>
          <VideoIcon />
        </button>
      </header>

      <main ref={scroller} className="flex flex-1 flex-col overflow-y-auto px-4 pb-4 pt-2">
        <div ref={content} className="mt-auto">
          {empty ? (
            <div className="flex flex-col items-center gap-3 pb-10 text-center">
              <span aria-hidden className="grid h-12 w-12 place-items-center rounded-2xl bg-ink">
                <span className="h-4 w-4 rounded-[5px] bg-signal" />
              </span>
              <h2 className="text-2xl font-semibold leading-[30px]">{T.chat.emptyTitle}</h2>
              <p className="max-w-[300px] text-[15px] leading-[22px] text-graphite">{isDocs ? T.doc.emptyLead : T.chat.emptyLead}</p>
            </div>
          ) : (
            <ChatView
              screen={screen}
              media={conversation.media ?? {}}
              animateFrom={animateFrom}
              maps={maps}
              mapFrom={mapFrom}
              progress={call ? [] : progress}
              pending={
                pending && (
                  <div className="anim-rise flex flex-col items-end gap-1.5">
                    {pending.frames?.[0] && (
                      // eslint-disable-next-line @next/next/no-img-element -- local data URL
                      <img src={pending.frames[0]} alt="" className="w-[60%] rounded-2xl rounded-es-md" />
                    )}
                    {pending.said && <div className="max-w-[80%] rounded-[18px] rounded-es-md bg-mist px-3.5 py-2.5 text-base leading-6">{pending.said}</div>}
                  </div>
                )
              }
              kbId={conversation.kbId || kbId}
              onOption={(text) => sendText(text)}
              onPick={(symptomId) => send(active, { kind: "pick", symptomId })}
              onOther={() => document.getElementById("composer-text")?.focus()}
              onAck={(symptomId) => send(active, { kind: "acknowledge", symptomId }, { said: T.stop.acknowledged })}
            />
          )}
          {error && <p className="mt-4 rounded-xl bg-mist px-3 py-2.5 text-sm text-danger-ink">{error}</p>}
          <div ref={bottom} />
        </div>
      </main>

      <div className="px-3 pb-1.5">
        <Composer
          placeholder={isDocs ? T.doc.placeholder : screen.mode === "identify" ? T.composer.describe : T.composer.answer}
          canAttach={canAttach}
          busy={busy || typing || !kbId}
          onSend={(text) => sendText(text)}
          onPhotos={sendPhotos}
          onVideo={sendVideo}
          onCancel={() => abort.current?.abort()}
        />
      </div>
      <p className="px-4 pb-3 pt-1.5 text-center text-[11px] text-stone">{isDocs ? T.doc.disclaimer : T.disclaimer}</p>

      {drawer && (
        <Cases
          kbs={kbs ?? []}
          kbId={kbId}
          showStatus={!isDocs}
          onKb={switchKb}
          recent={recent}
          currentId={conversation.id}
          onOpen={(c) => {
            const base = { conversation: c, screen: EMPTY };
            open(base);
            void send(base, { kind: "view" });
          }}
          onNew={() => open(fresh())}
          onClose={() => setDrawer(false)}
        />
      )}

      {call && (
        <CallView
          kind={call}
          kbId={conversation.kbId || kbId}
          kbName={kb?.name ?? T.appTitle}
          disclaimer={isDocs ? T.doc.disclaimer : T.disclaimer}
          title={screen.title ?? T.appTitle}
          screen={screen}
          speech={speech}
          busy={busy}
          progress={progress.at(-1)?.key}
          visual={callVisual}
          onUtterance={(text, frame) => sendText(text, frame, true)}
          onAck={(symptomId) => send(activeRef.current, { kind: "acknowledge", symptomId }, { said: T.stop.acknowledged }, true)}
          onHangUp={() => {
            window.speechSynthesis?.cancel();
            setCall(null);
          }}
        />
      )}
    </div>
  );
}
