// The implementer's area: set up a knowledge base per customer or machine and load documents
// into it. Technicians never see this screen; they ask against the knowledge base chosen here.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocMeta, DocOrigin, KbMeta, Usage } from "@/lib/store/types";
import { T } from "@/lib/ui-text";
import { BRAND } from "@/lib/brand";
import { CheckIcon, CloseIcon, DocIcon, LockIcon, PlusIcon, WarningIcon } from "./icons";
import { Logo } from "./Logo";
import { CallTraces, Conversations, Dashboard, Environments, Gaps, TryQuestion } from "./AdminDash";
import { envBase } from "@/lib/client/env";
import type { EnvView } from "@/lib/store/envs";
import { SILENCE } from "@/lib/client/voice";

// `indexed` of `sections`: how much of the document can be searched by meaning.
type Doc = DocMeta & { indexed?: number; sections?: number };
type Kb = KbMeta & { docs: Doc[]; usage: Usage };
type Upload = { id: number; name: string; state: "working" | "done" | "error"; message?: string };

const A = T.admin;
// "envs" is the main administrator's only.
const PAGES = ["overview", "envs", "kbs", "conversations", "quality", "system"] as const;
type Page = (typeof PAGES)[number];
const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.json,.html,.htm";

function size(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Login({ closed, onDone }: { closed: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) onDone();
    else setWrong(true);
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-5">
      <Logo size={40} tagline />
      <h1 className="pt-2 text-2xl font-semibold">{A.login.title}</h1>
      {closed ? (
        <p className="rounded-xl bg-mist px-3.5 py-3 text-[15px] leading-6">{A.login.closed}</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="admin-password" className="text-sm font-medium text-graphite">
            {A.login.password}
          </label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => (setPassword(e.target.value), setWrong(false))}
            className="h-12 rounded-[14px] border border-edge bg-paper px-3.5 text-base focus:border-primary"
          />
          {wrong && (
            <p role="alert" className="text-base text-danger-ink">
              {A.login.wrong}
            </p>
          )}
          <button disabled={busy || !password} className="h-12 rounded-[14px] bg-primary text-base font-medium text-white disabled:opacity-40">
            {A.login.submit}
          </button>
        </form>
      )}
    </main>
  );
}

function KbForm({ initial, submit, onSubmit, onCancel }: { initial?: { name: string; description: string; ideas?: boolean }; submit: string; onSubmit: (v: { name: string; description: string; ideas: boolean }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [ideas, setIdeas] = useState(initial?.ideas !== false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSubmit({ name, description, ideas });
        setBusy(false);
      }}
      className="flex flex-col gap-3 rounded-[18px] border border-rule p-4"
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-graphite">
        <span>{A.kbName}</span>
        <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={A.kbNamePlaceholder} className="h-11 rounded-xl border border-edge bg-paper px-3 text-base font-normal text-ink focus:border-primary" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-graphite">
        <span>{A.kbDescription}</span>
        <input value={description} maxLength={400} onChange={(e) => setDescription(e.target.value)} className="h-11 rounded-xl border border-edge bg-paper px-3 text-base font-normal text-ink focus:border-primary" />
      </label>
      {initial && (
        <label className="flex items-start gap-2.5 text-[15px] text-ink">
          <input type="checkbox" checked={ideas} onChange={(e) => setIdeas(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-primary" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{A.ideasToggle}</span>
            <span className="text-sm text-graphite">{A.ideasToggleHint}</span>
          </span>
        </label>
      )}
      <div className="flex gap-2">
        <button disabled={busy || !name.trim()} className="h-11 rounded-xl bg-primary px-5 text-[15px] font-medium text-white disabled:opacity-40">
          {submit}
        </button>
        <button type="button" onClick={onCancel} className="h-11 rounded-xl px-4 text-[15px] text-graphite active:bg-mist">
          {A.cancel}
        </button>
      </div>
    </form>
  );
}

// How technicians used this knowledge base. "Not found" is the list of documents still missing.
function UsageTiles({ usage }: { usage: Usage }) {
  const tile = (label: string, value: number, tone = "") => (
    <div className="flex flex-col gap-0.5 rounded-[14px] bg-mist px-3.5 py-3">
      <span className={`font-mono text-2xl font-medium ${tone}`}>{value}</span>
      <span className="text-[13px] text-graphite">{label}</span>
    </div>
  );
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[17px] font-semibold">{A.usage.title}</h3>
      {usage.questions === 0 ? (
        <p className="text-[15px] text-stone">{A.usage.none}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tile(A.usage.questions, usage.questions)}
            {tile(A.usage.answer, usage.answer, "text-ok")}
            {tile(A.usage.ask, usage.ask)}
            {tile(A.usage.not_found, usage.not_found + usage.ideas)}
          </div>
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-[15px] text-graphite">
            <span>
              <span>{A.usage.ideas}:</span> <span className="font-mono text-ink">{usage.ideas}</span>
            </span>
            <span>
              <span>{A.usage.hazard}:</span> <span className="font-mono text-ink">{usage.hazard}</span>
            </span>
            <span>
              <span>{A.usage.helpful}:</span> <span className="font-mono text-ok">{usage.helpful}</span>
            </span>
            <span>
              <span>{A.usage.unhelpful}:</span> <span className="font-mono text-ink">{usage.unhelpful}</span>
            </span>
          </p>
          <p className="flex flex-wrap gap-x-3 text-[13px] text-stone">
            {usage.lastAt && (
              <span>
                <span>{A.usage.last}</span> <span className="font-mono">{new Date(usage.lastAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}</span>
              </span>
            )}
            {usage.error > 0 && (
              <span className="text-danger-ink">
                <span>{A.usage.error}:</span> <span className="font-mono">{usage.error}</span>
              </span>
            )}
          </p>
        </>
      )}
    </section>
  );
}

type LiveVoices = { enabled: boolean; current: string; language: string; languages: { code: string; name: string }[]; voices: { name: string; label: string; gender: "male" | "female"; style: string }[] };

// The live call's voice: every voice has a Hebrew name, a play button and a choose button.
// The sample is the live model itself, so what is heard here is what a technician hears.
function LiveVoicePicker() {
  const [list, setList] = useState<LiveVoices | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/admin/voice/live")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => alive && setList(data as LiveVoices | null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const play = async (voice: string) => {
    // Created and started inside the tap: a phone refuses a sound that starts after a network wait.
    const audio = new Audio(SILENCE);
    void audio.play().catch(() => {});
    setBusy(voice);
    setProblem(null);
    const res = await fetch("/api/admin/voice/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice, text: A.liveVoice.sample }) }).catch(() => null);
    if (res?.ok) {
      const url = URL.createObjectURL(await res.blob());
      audio.onended = () => URL.revokeObjectURL(url);
      audio.src = url;
      await audio.play().catch((e: Error) => setProblem(`${A.liveVoice.failed} ${e.name}`));
    } else {
      const body = (await res?.json().catch(() => null)) as { detail?: string } | null;
      setProblem(body?.detail ? `${A.liveVoice.failed} ${body.detail}` : A.liveVoice.failed);
    }
    setBusy(null);
  };
  const choose = async (voice: string) => {
    const res = await fetch("/api/admin/voice/live", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice }) }).catch(() => null);
    if (res?.ok) setList((l) => l && { ...l, current: voice });
    else setProblem(A.errors.generic);
  };
  const setLanguage = async (language: string) => {
    const res = await fetch("/api/admin/voice/live", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language }) }).catch(() => null);
    if (res?.ok) setList((l) => l && { ...l, language });
    else setProblem(A.errors.generic);
  };
  if (!list) return null;
  return (
    <section className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 rounded-[10px] border border-rule bg-paper px-4 py-3">
        <span className="text-[15px] font-bold">{A.liveVoice.language}</span>
        <span className="text-[13px] text-stone">{A.liveVoice.languageHint}</span>
        <select value={list.language} onChange={(e) => void setLanguage(e.target.value)} className="mt-1 h-11 w-56 rounded-[8px] border border-edge bg-paper px-2.5 text-[15px]">
          {list.languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <h2 className="text-[17px] font-bold">{A.liveVoice.title}</h2>
        <p className="text-[14px] text-stone">{list.enabled ? A.liveVoice.lead : A.liveVoice.off}</p>
      </div>
      {busy && (
        <p role="status" className="text-[14px] text-graphite">
          {A.liveVoice.preparing}
        </p>
      )}
      {problem && (
        <p role="alert" dir="auto" className="text-[14px] text-danger-ink">
          {problem}
        </p>
      )}
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {list.voices.map((v) => {
          const on = v.name === list.current;
          return (
            <li key={v.name} className={`flex items-center gap-3 rounded-[10px] border bg-paper px-3.5 py-3 ${on ? "border-primary shadow-[0_0_0_1px_var(--color-primary)]" : "border-rule"}`}>
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-semibold">{v.label}</p>
                <p className="text-[13px] text-stone">
                  <span>{A.liveVoice[v.gender]}</span> · <span>{v.style}</span>
                </p>
              </div>
              <button onClick={() => play(v.name)} disabled={!list.enabled || busy !== null} className="h-10 rounded-[8px] border border-edge px-3 text-[14px] font-medium hover:bg-mist disabled:opacity-40">
                {A.liveVoice.play}
              </button>
              {on ? (
                <span className="flex h-10 items-center gap-1 px-1 text-[14px] font-medium text-ok">
                  <CheckIcon className="h-4 w-4" />
                  {A.liveVoice.chosen}
                </span>
              ) : (
                <button onClick={() => choose(v.name)} className="h-10 rounded-[8px] bg-primary px-3 text-[14px] font-medium text-white hover:bg-primary-strong">
                  {A.liveVoice.choose}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type VoiceList = { enabled: boolean; current: string; voices: { name: string; gender: string; provider: string }[]; error?: string };
const PROVIDER: Record<string, string> = { gemini: "Google Gemini", google: "Google", azure: "Microsoft", eleven: "ElevenLabs" };

// The implementer listens to the Hebrew voices the account offers and picks the one the
// assistant speaks with in a call.
function VoicePicker() {
  const [list, setList] = useState<VoiceList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // What the "play" buttons say. Editable, so any sentence that sounds wrong can be tried.
  const [text, setText] = useState<string>(A.voice.sample);
  const load = async () => {
    setBusy("load");
    const res = await fetch("/api/admin/voice").catch(() => null);
    setList(res?.ok ? ((await res.json()) as VoiceList) : { enabled: true, current: "", voices: [], error: A.errors.generic });
    setBusy(null);
  };
  const [heardIn, setHeardIn] = useState<string | null>(null);
  const play = async (voice: string) => {
    // Created and started inside the tap: a phone (an iPhone above all) refuses to play a sound
    // that only starts after the network wait.
    const audio = new Audio(SILENCE);
    void audio.play().catch(() => {});
    setBusy(voice);
    setProblem(null);
    setHeardIn(null);
    const res = await fetch("/api/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) }).catch(() => null);
    if (res?.ok) {
      const url = URL.createObjectURL(await res.blob());
      const ms = Number(res.headers.get("X-Voice-Ms"));
      setHeardIn(ms > 0 ? `${voice.replace(/^[a-z]+:/, "")} · ${(ms / 1000).toFixed(1)}s` : null);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.src = url;
      await audio.play().catch((e: Error) => setProblem(`${A.voice.failed} ${e.name}`));
    } else {
      const body = (await res?.json().catch(() => null)) as { detail?: string } | null;
      setProblem(body?.detail ? `${A.voice.failed} ${body.detail}` : A.voice.failed);
    }
    setBusy(null);
  };
  const choose = async (voice: string) => {
    setBusy(voice);
    const res = await fetch("/api/admin/voice", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice }) }).catch(() => null);
    if (res?.ok) setList((l) => l && { ...l, current: voice });
    setBusy(null);
  };
  return (
    <section className="flex flex-col gap-2.5">
      <h4 className="text-[15px] font-semibold">{A.voice.title}</h4>
      {!list ? (
        <button onClick={load} disabled={busy !== null} className="h-10 self-start rounded-xl border border-rule px-4 text-[15px] font-medium active:bg-mist disabled:opacity-50">
          {A.voice.load}
        </button>
      ) : !list.enabled ? (
        <p className="text-[15px] text-graphite">{A.voice.off}</p>
      ) : (
        <>
          <p className="text-[15px] text-graphite">{A.voice.lead}</p>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-graphite">
            <span>{A.voice.text}</span>
            <textarea value={text} maxLength={600} rows={2} onChange={(e) => setText(e.target.value)} className="rounded-xl border border-edge bg-paper px-3 py-2 text-base font-normal text-ink focus:border-primary" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setText(A.voice.sample)} className="h-9 rounded-lg border border-edge px-3 text-sm font-medium">
              {A.voice.plain}
            </button>
            <button onClick={() => setText(A.voice.samplePointed)} className="h-9 rounded-lg border border-edge px-3 text-sm font-medium">
              {A.voice.pointed}
            </button>
          </div>
          {list.error && (
            <p role="alert" dir="ltr" className="break-words text-start font-mono text-xs text-danger-ink">
              {list.error}
            </p>
          )}
          {list.voices.length === 0 && !list.error && <p className="text-[15px] text-stone">{A.voice.none}</p>}
          <ul className="flex flex-col divide-y divide-rule-soft rounded-[14px] border border-rule">
            {list.voices.map((v) =>
              v.provider.endsWith("-error") ? (
                <li key={v.provider} role="alert" className="px-3 py-2 text-sm text-danger-ink">
                  <span className="font-medium">{PROVIDER[v.provider.replace("-error", "")] ?? v.provider}:</span>{" "}
                  <span dir="ltr" className="break-words font-mono text-xs">
                    {v.gender}
                  </span>
                </li>
              ) : (
              <li key={v.name} className="flex items-center gap-2 px-3 py-2">
                <span className="w-24 shrink-0 text-sm text-graphite">{PROVIDER[v.provider] ?? v.provider}</span>
                <span dir="ltr" className="min-w-0 flex-1 truncate text-start font-mono text-sm" title={v.gender}>
                  {v.provider === "eleven" ? v.gender : v.name.replace(/^[a-z]+:/, "")}
                </span>
                {list.current === v.name && <span className="text-sm font-medium text-ok">{A.voice.chosen}</span>}
                <button onClick={() => play(v.name)} disabled={busy !== null || !text.trim()} className="h-9 rounded-lg border border-edge px-3 text-sm font-medium disabled:opacity-50">
                  {A.voice.play}
                </button>
                {list.current !== v.name && (
                  <button onClick={() => choose(v.name)} disabled={busy !== null} className="h-9 rounded-lg bg-primary px-3 text-sm font-medium text-white disabled:opacity-50">
                    {A.voice.choose}
                  </button>
                )}
              </li>
              ),
            )}
          </ul>
          {busy && busy !== "load" && (
            <p role="status" className="text-sm text-graphite">
              {A.voice.preparing}
            </p>
          )}
          {heardIn && !busy && (
            <p role="status" dir="ltr" className="text-start font-mono text-xs text-stone">
              {heardIn}
            </p>
          )}
          {problem && (
            <p role="alert" dir="auto" className="break-words text-sm text-danger-ink">
              {problem}
            </p>
          )}
        </>
      )}
    </section>
  );
}

type DiagnoseCheck = { name: "key_and_model" | "question_answering" | "fast_search" | "embeddings" | "live_call"; ok: boolean; ms: number; detail?: string };

// Asks the server to try the model: first the key, then one full question on a sample page.
// On failure the provider's own message is shown, so the implementer knows what to fix.
function Diagnose() {
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<DiagnoseCheck[] | null>(null);
  const run = async () => {
    setBusy(true);
    const res = await fetch("/api/admin/diagnose", { method: "POST" }).catch(() => null);
    const data = res?.ok ? ((await res.json()) as { checks: DiagnoseCheck[] }) : null;
    setChecks(data?.checks ?? [{ name: "key_and_model", ok: false, ms: 0, detail: A.errors.generic }]);
    setBusy(false);
  };
  return (
    <section className="flex flex-col gap-2.5">
      <button onClick={run} disabled={busy} className="h-10 self-start rounded-xl border border-rule px-4 text-[15px] font-medium active:bg-mist disabled:opacity-50">
        {busy ? A.diagnose.running : A.diagnose.run}
      </button>
      {checks && (
        <ul aria-live="polite" className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <li key={c.name} className="flex flex-col gap-0.5 rounded-xl bg-mist px-3.5 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                {c.ok ? <CheckIcon className="h-4 w-4 text-ok" /> : <WarningIcon className="h-4 w-4 text-danger" />}
                <span className="font-medium">{A.diagnose[c.name]}</span>
                <span className={c.ok ? "text-ok" : "text-danger-ink"}>{c.ok ? A.diagnose.ok : A.diagnose.failed}</span>
                <span className="font-mono text-xs text-stone">{(c.ms / 1000).toFixed(1)}s</span>
              </span>
              {c.detail && (
                <span dir="ltr" className="break-words text-start font-mono text-xs text-graphite">
                  {c.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Documents({ kb, embeddings, onChanged }: { kb: Kb; embeddings: string | null; onChanged: () => Promise<void> }) {
  const [origin, setOrigin] = useState<DocOrigin>("manufacturer");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const counter = useRef(0);
  // The document whose meaning index is being built, or the provider's message when it failed.
  const [indexing, setIndexing] = useState<{ docId: string; error?: string } | null>(null);

  // Each call indexes for a bounded time; repeat until the document is done.
  const buildIndex = async (docs: Doc[]) => {
    for (const d of docs) {
      setIndexing({ docId: d.id });
      for (;;) {
        const res = await fetch(`/api/admin/kbs/${kb.id}/docs/${d.id}/index`, { method: "POST" }).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { done?: boolean; detail?: string; error?: string } | null;
        await onChanged();
        if (!res?.ok) return setIndexing({ docId: d.id, error: body?.detail ?? body?.error ?? A.errors.generic });
        if (body?.done) break;
      }
    }
    setIndexing(null);
  };

  // Documents whose meaning index is missing or was made for an older way of cutting pages are
  // indexed again by themselves when the screen opens: nobody has to press anything.
  const started = useRef(false);
  useEffect(() => {
    const stale = kb.docs.filter((d) => (d.indexed ?? 0) < (d.sections ?? 0));
    if (!embeddings || started.current || !stale.length) return;
    started.current = true;
    const t = setTimeout(() => void buildIndex(stale), 0);
    return () => clearTimeout(t);
    // Once per screen; `buildIndex` reads the current knowledge base.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddings, kb.docs]);

  const upload = async (files: File[]) => {
    for (const file of files) {
      const id = ++counter.current;
      setUploads((u) => [...u, { id, name: file.name, state: "working" }]);
      const form = new FormData();
      form.set("file", file);
      form.set("origin", origin);
      const res = await fetch(`/api/admin/kbs/${kb.id}/docs`, { method: "POST", body: form }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { error?: keyof typeof A.errors; doc?: Doc } | null;
      const message = res?.ok ? undefined : (A.errors[body?.error ?? "generic"] ?? A.errors.generic);
      setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: res?.ok ? "done" : "error", message } : x)));
      if (res?.ok) await onChanged();
      if (res?.ok && embeddings && body?.doc) await buildIndex([body.doc]);
    }
  };

  const remove = async (doc: DocMeta) => {
    if (!window.confirm(A.confirmDeleteDoc)) return;
    await fetch(`/api/admin/kbs/${kb.id}/docs/${doc.id}`, { method: "DELETE" });
    await onChanged();
  };

  const rename = async (doc: DocMeta) => {
    const name = window.prompt(A.renameDocPrompt, doc.name)?.trim();
    if (!name || name === doc.name) return;
    await fetch(`/api/admin/kbs/${kb.id}/docs/${doc.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    await onChanged();
  };

  const originButton = (value: DocOrigin, label: string) => (
    <button
      type="button"
      onClick={() => setOrigin(value)}
      aria-pressed={origin === value}
      className={`h-9 rounded-lg px-3.5 text-sm ${origin === value ? "bg-primary font-medium text-white" : "text-graphite active:bg-rule"}`}
    >
      {label}
    </button>
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[17px] font-semibold">{A.upload}</h3>
        <div className="flex items-center gap-2 text-sm text-graphite">
          <span>{A.originLabel}</span>
          <span className="flex rounded-[10px] bg-mist p-0.5">
            {originButton("manufacturer", T.doc.manufacturer)}
            {originButton("customer", T.doc.customer)}
          </span>
        </div>
      </div>

      <label
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload([...e.dataTransfer.files]);
        }}
        className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-[18px] border-2 border-dashed px-4 py-8 text-center ${over ? "border-primary bg-primary-soft" : "border-rule"}`}
      >
        <span className="grid h-11 w-11 place-items-center rounded-full bg-primary text-white">
          <PlusIcon />
        </span>
        <span className="text-base font-medium">{A.drop}</span>
        <span className="text-[13px] text-stone">{A.uploadHint}</span>
        <input
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void upload(files);
          }}
        />
      </label>

      {uploads.length > 0 && (
        <ul aria-live="polite" className="flex flex-col gap-1.5">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-2.5 rounded-xl bg-mist px-3 py-2.5 text-sm">
              {u.state === "working" ? (
                <svg aria-hidden className="anim-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="9" stroke="var(--color-rule)" />
                  <path d="M12 3a9 9 0 0 1 9 9" stroke="var(--color-ink)" strokeLinecap="round" />
                </svg>
              ) : u.state === "done" ? (
                <CheckIcon className="h-4 w-4 shrink-0 text-ok" />
              ) : (
                <WarningIcon className="h-4 w-4 shrink-0 text-danger" />
              )}
              <span dir="auto" className="min-w-0 flex-1 truncate">
                {u.name}
              </span>
              <span className={u.state === "error" ? "text-danger-ink" : "text-stone"}>{u.state === "working" ? A.uploading : u.state === "done" ? A.uploaded : u.message}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="pt-2 text-[17px] font-semibold">
        <span>{T.doc.documents}</span> <span className="font-mono text-sm font-normal text-stone">{kb.docs.length}</span>
      </h3>
      {kb.docs.length === 0 ? (
        <p className="text-[15px] text-stone">{A.noDocs}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule-soft rounded-[18px] border border-rule">
          {kb.docs.map((d) => (
            <li key={d.id} className="flex items-start gap-3 px-3.5 py-3">
              <DocIcon className="mt-1 h-5 w-5 shrink-0 text-graphite" />
              <div className="min-w-0 flex-1">
                <p dir="auto" className="truncate text-[15px] font-medium">
                  {d.name}
                </p>
                <p className="flex flex-wrap gap-x-2 text-[13px] text-stone">
                  <span className="rounded bg-mist px-1.5 text-graphite">{d.origin === "customer" ? T.doc.customer : T.doc.manufacturer}</span>
                  <span>
                    <span className="font-mono">{d.passages}</span> <span>{d.unit === "page" ? A.pages : A.parts}</span>
                  </span>
                  <span className="font-mono">{size(d.bytes)}</span>
                  <span className="font-mono uppercase">{d.ext.slice(1)}</span>
                </p>
                {embeddings && (
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-graphite">
                    {indexing?.docId === d.id && !indexing.error ? (
                      <span role="status">
                        <span>{A.semantic.working}</span> <span className="font-mono">{d.indexed ?? 0}/{d.sections ?? d.passages}</span>
                      </span>
                    ) : (d.indexed ?? 0) >= (d.sections ?? d.passages) ? (
                      <span>{A.semantic.ready}</span>
                    ) : (
                      <>
                        <span>
                          <span>{A.semantic.partial}</span> <span className="font-mono">{d.indexed ?? 0}/{d.sections ?? d.passages}</span>
                        </span>
                        <button disabled={Boolean(indexing && !indexing.error)} onClick={() => buildIndex([d])} className="rounded-lg border border-edge px-2.5 py-1 text-[13px] font-medium text-primary disabled:opacity-40">
                          {A.semantic.build}
                        </button>
                      </>
                    )}
                    {indexing?.docId === d.id && indexing.error && (
                      <span role="alert" className="text-danger-ink">
                        <span>{A.semantic.failed}</span> <span dir="auto">{indexing.error}</span>
                      </span>
                    )}
                  </p>
                )}
                {d.empty > 0 && (
                  <p className="mt-1 flex items-center gap-1.5 text-[13px] text-danger-ink">
                    <WarningIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono">{d.empty}</span>
                    <span>{A.emptyPages}</span>
                  </p>
                )}
              </div>
              <a href={`/api/kbs/${kb.id}/docs/${d.id}/file`} target="_blank" rel="noopener" className="rounded-lg px-2.5 py-1.5 text-sm text-graphite active:bg-mist">
                {A.open}
              </a>
              <button onClick={() => rename(d)} className="rounded-lg px-2.5 py-1.5 text-sm text-graphite active:bg-mist">
                {A.renameDoc}
              </button>
              <button onClick={() => remove(d)} className="rounded-lg px-2.5 py-1.5 text-sm text-danger-ink active:bg-mist">
                {A.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdminApp() {
  const [state, setState] = useState<"loading" | "login" | "closed" | "ready">("loading");
  const [kbs, setKbs] = useState<Kb[]>([]);
  const [ai, setAi] = useState(true);
  const [accessCode, setAccessCode] = useState(true);
  const [embeddings, setEmbeddings] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const [page, setPage] = useState<Page>("overview");
  const [env, setEnv] = useState<EnvView | null>(null);
  // The main administrator, on the main environment: sees every environment.
  const [master, setMaster] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/kbs").catch(() => null);
    if (!res) return setError(true);
    if (res.status === 401) {
      // Without a configured password the server refuses in production.
      const probe = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
      return setState(probe?.status === 503 ? "closed" : "login");
    }
    const data = (await res.json()) as { kbs: Kb[]; ai: boolean; accessCode: boolean; embeddings: string | null; env: EnvView; master: boolean };
    setEnv(data.env);
    setMaster(data.master);
    setKbs(data.kbs);
    setAi(data.ai);
    setAccessCode(data.accessCode);
    setEmbeddings(data.embeddings);
    setSelected((s) => (data.kbs.some((k) => k.id === s) ? s : (data.kbs[0]?.id ?? "")));
    setState("ready");
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  if (state === "loading") return <main className="grid min-h-dvh place-items-center text-stone">{T.doc.loading}</main>;
  if (state !== "ready") return <Login closed={state === "closed"} onDone={load} />;

  const kb = kbs.find((k) => k.id === selected);
  const base = envBase();
  const link = kb && typeof window !== "undefined" ? `${window.location.origin}${base}/?kb=${kb.id}` : "";

  const signOut = async () => {
    await fetch("/api/admin/login", { method: "DELETE" }).catch(() => {});
    window.location.reload();
  };

  const call = async (url: string, method: string, body?: object) => {
    setError(false);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (!res?.ok) setError(true);
    return res?.ok ? ((await res.json()) as { kb?: Kb }) : null;
  };

  const go = (to: Page) => (setPage(to), setCreating(false), setEditing(false));

  const kbPicker = kbs.length > 1 && (
    <label className="flex items-center gap-2 text-[14px] text-graphite">
      <span>{A.switchKb}</span>
      <select value={selected} onChange={(e) => (setSelected(e.target.value), setCreating(false), setEditing(false))} className="h-10 rounded-[8px] border border-edge bg-paper px-2.5 text-[15px] text-ink">
        {kbs.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-side md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-rule bg-side md:sticky md:top-0 md:h-dvh md:w-[248px] md:border-b-0 md:border-e">
        <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
          <div className="flex flex-col gap-1.5">
            <Logo size={30} />
            <span className="text-[13px] text-stone">{env && !env.main ? <bdi>{env.name}</bdi> : A.workspace}</span>
          </div>
        </div>
        <nav aria-label={A.workspace} className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
          {PAGES.filter((p) => p !== "envs" || master).map((p) => (
            <button
              key={p}
              onClick={() => go(p)}
              aria-current={page === p ? "page" : undefined}
              className={`h-11 shrink-0 rounded-[8px] px-3 text-start text-[15px] md:rounded-s-none md:border-s-[3px] ${page === p ? "bg-side-on font-semibold text-ink md:border-primary" : "text-graphite hover:bg-side-on/60 md:border-transparent"}`}
            >
              {A.nav[p]}
            </button>
          ))}
        </nav>
        <div className="mt-auto hidden flex-col gap-1 border-t border-rule p-4 md:flex">
          <p dir="ltr" className="text-end font-mono text-[13px] text-stone">
            {BRAND.name} Workspace
          </p>
          <a href={kb ? `${base}/?kb=${kb.id}` : `${base}/`} className="rounded-[8px] px-2 py-2 text-[14px] text-graphite hover:bg-side-on">
            {A.toChat}
          </a>
          <button onClick={signOut} className="rounded-[8px] px-2 py-2 text-start text-[14px] text-graphite hover:bg-side-on">
            {A.signOut}
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-6 bg-canvas px-5 pb-12 pt-7 md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-5">
          <div>
            <h1 className="text-[28px] font-extrabold leading-[34px] tracking-[-0.035em]">{A.nav[page]}</h1>
            <p className="pt-1 text-[15px] text-stone">{A.sub[page]}</p>
          </div>
          {page === "kbs" && !creating && (
            <button onClick={() => setCreating(true)} className="flex h-11 items-center gap-2 rounded-[9px] bg-primary px-4 text-[15px] font-medium text-white hover:bg-primary-strong">
              <PlusIcon className="h-5 w-5" />
              <span>{A.newKb}</span>
            </button>
          )}
          <div className="flex gap-1 md:hidden">
            <a href={kb ? `${base}/?kb=${kb.id}` : `${base}/`} className="rounded-[8px] px-3 py-2 text-[14px] text-graphite">
              {A.toChat}
            </a>
            <button onClick={signOut} className="rounded-[8px] px-3 py-2 text-[14px] text-graphite">
              {A.signOut}
            </button>
          </div>
        </div>

        {!ai && (
          <p className="flex items-start gap-2.5 rounded-[10px] border border-signal bg-signal-soft px-3.5 py-3 text-[15px] leading-6">
            <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
            <span>{A.noAi}</span>
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-[10px] border border-danger px-3.5 py-3 text-[15px] text-danger-ink">
            {A.errors.generic}
          </p>
        )}

        {page === "overview" && (
          <>
            <Dashboard />
            <section className="flex flex-col gap-2">
              <h2 className="text-[17px] font-bold">{A.activeKbs}</h2>
              <ul className="overflow-hidden rounded-[12px] border border-rule bg-paper">
                {kbs.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 border-b border-rule-soft px-4 py-3 last:border-b-0">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] bg-primary-soft text-primary">
                      <DocIcon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <bdi className="block truncate text-[15px] font-semibold">{k.name}</bdi>
                      <span className="block text-[13px] text-stone">
                        <span className="font-mono">{k.docs.length}</span> <span>{T.doc.documents}</span> · <span className="font-mono">{k.usage.questions}</span> <span>{A.totals.questions}</span>
                      </span>
                    </span>
                    <button onClick={() => (setSelected(k.id), go("kbs"))} className="h-10 rounded-[8px] border border-edge px-3.5 text-[14px] font-medium hover:bg-mist">
                      {A.openKb}
                    </button>
                  </li>
                ))}
                {kbs.length === 0 && <li className="px-4 py-4 text-[15px] text-stone">{A.noDocs}</li>}
              </ul>
            </section>
          </>
        )}

        {page === "kbs" &&
          (creating ? (
            <KbForm
              submit={A.create}
              onCancel={() => setCreating(false)}
              onSubmit={async (v) => {
                const res = await call("/api/admin/kbs", "POST", v);
                if (res?.kb) {
                  await load();
                  setSelected(res.kb.id);
                  setCreating(false);
                }
              }}
            />
          ) : kb ? (
            <>
              {editing ? (
                <KbForm
                  initial={kb}
                  submit={A.save}
                  onCancel={() => setEditing(false)}
                  onSubmit={async (v) => {
                    if (await call(`/api/admin/kbs/${kb.id}`, "PATCH", v)) {
                      await load();
                      setEditing(false);
                    }
                  }}
                />
              ) : (
                <section className="flex flex-col gap-4 rounded-[12px] border border-rule bg-paper p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] text-stone">{T.doc.kb}</p>
                      <h2 className="text-[22px] font-bold leading-8 tracking-[-0.02em]">
                        <bdi>{kb.name}</bdi>
                      </h2>
                      {kb.description && <p className="text-[15px] text-graphite">{kb.description}</p>}
                      {kb.ideas === false && <p className="text-sm text-graphite">{A.ideasOff}</p>}
                    </div>
                    {kbPicker}
                  </div>
                  <div className="flex items-center gap-2 rounded-[10px] border border-rule bg-mist py-1.5 pe-1.5 ps-3.5">
                    <span className="shrink-0 text-[13px] font-medium text-graphite">{A.technicianLink}</span>
                    <span dir="ltr" className="min-w-0 flex-1 truncate text-start font-mono text-[13px]">
                      {link}
                    </span>
                    <button
                      onClick={async () => {
                        await navigator.clipboard?.writeText(link).catch(() => {});
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                      className="h-9 shrink-0 rounded-[8px] border border-edge bg-paper px-3.5 text-sm font-medium"
                    >
                      {copied ? A.copied : A.copy}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button onClick={() => setEditing(true)} className="h-10 rounded-[8px] border border-edge px-3.5 text-sm font-medium hover:bg-mist">
                      {A.rename}
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm(A.confirmDeleteKb)) return;
                        if (await call(`/api/admin/kbs/${kb.id}`, "DELETE")) await load();
                      }}
                      className="flex h-10 items-center gap-1 rounded-[8px] px-3 text-sm text-danger-ink hover:bg-mist"
                    >
                      <CloseIcon className="h-4 w-4" />
                      <span>{A.deleteKb}</span>
                    </button>
                  </div>
                </section>
              )}
              {!accessCode && <p className="text-[13px] leading-5 text-stone">{A.openAccess}</p>}
              <p className="text-[13px] leading-5 text-stone">{embeddings ? <><span>{A.semantic.on}</span> <span dir="ltr" className="font-mono">{embeddings}</span></> : A.semantic.off}</p>
              <Documents key={kb.id} kb={kb} embeddings={embeddings} onChanged={load} />
              {kb.docs.length > 0 && <TryQuestion key={`try-${kb.id}`} kbId={kb.id} />}
            </>
          ) : (
            <p className="text-[15px] text-stone">{A.noDocs}</p>
          ))}

        {page === "envs" && master && <Environments />}

        {page === "conversations" && (
          <>
            <CallTraces />
            <Conversations />
          </>
        )}

        {page === "quality" && (
          <>
            {kbPicker}
            {kb && <UsageTiles usage={kb.usage} />}
            {kb && <Gaps kbId={kb.id} />}
            <p className="flex items-start gap-2.5 rounded-[10px] border border-rule bg-paper px-4 py-3 text-[14px] leading-[21px] text-graphite">
              <LockIcon className="mt-0.5 h-5 w-5 shrink-0 text-stone" />
              <span>{A.privacy}</span>
            </p>
          </>
        )}

        {page === "system" && (
          <section className="flex flex-col gap-6">
            <Diagnose />
            <LiveVoicePicker />
            <VoicePicker />
          </section>
        )}
      </main>
    </div>
  );
}
