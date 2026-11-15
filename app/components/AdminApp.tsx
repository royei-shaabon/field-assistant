// The implementer's area: set up a knowledge base per customer or machine and load documents
// into it. Technicians never see this screen; they ask against the knowledge base chosen here.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocMeta, DocOrigin, KbMeta, Usage } from "@/lib/store/types";
import { T } from "@/lib/ui-text";
import { CheckIcon, CloseIcon, DocIcon, PlusIcon, WarningIcon } from "./icons";

type Kb = KbMeta & { docs: DocMeta[]; usage: Usage };
type Upload = { id: number; name: string; state: "working" | "done" | "error"; message?: string };

const A = T.admin;
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
      <h1 className="text-2xl font-semibold">{A.login.title}</h1>
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
            className="h-12 rounded-[14px] border border-edge bg-paper px-3.5 text-base focus:border-ink"
          />
          {wrong && (
            <p role="alert" className="text-base text-danger-ink">
              {A.login.wrong}
            </p>
          )}
          <button disabled={busy || !password} className="h-12 rounded-[14px] bg-ink text-base font-medium text-white disabled:opacity-40">
            {A.login.submit}
          </button>
        </form>
      )}
    </main>
  );
}

function KbForm({ initial, submit, onSubmit, onCancel }: { initial?: { name: string; description: string }; submit: string; onSubmit: (v: { name: string; description: string }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSubmit({ name, description });
        setBusy(false);
      }}
      className="flex flex-col gap-3 rounded-[18px] border border-rule p-4"
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-graphite">
        <span>{A.kbName}</span>
        <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={A.kbNamePlaceholder} className="h-11 rounded-xl border border-edge bg-paper px-3 text-base font-normal text-ink focus:border-ink" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-graphite">
        <span>{A.kbDescription}</span>
        <input value={description} maxLength={400} onChange={(e) => setDescription(e.target.value)} className="h-11 rounded-xl border border-edge bg-paper px-3 text-base font-normal text-ink focus:border-ink" />
      </label>
      <div className="flex gap-2">
        <button disabled={busy || !name.trim()} className="h-11 rounded-xl bg-ink px-5 text-[15px] font-medium text-white disabled:opacity-40">
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {tile(A.usage.questions, usage.questions)}
            {tile(A.usage.answer, usage.answer, "text-ok")}
            {tile(A.usage.ask, usage.ask)}
            {tile(A.usage.not_found, usage.not_found)}
            {tile(A.usage.hazard, usage.hazard)}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {tile(A.usage.helpful, usage.helpful, "text-ok")}
            {tile(A.usage.unhelpful, usage.unhelpful)}
          </div>
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

type DiagnoseCheck = { name: "key_and_model" | "question_answering"; ok: boolean; ms: number; detail?: string };

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
    <section className="mb-5 flex flex-col gap-2.5">
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

function Documents({ kb, onChanged }: { kb: Kb; onChanged: () => Promise<void> }) {
  const [origin, setOrigin] = useState<DocOrigin>("manufacturer");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const counter = useRef(0);

  const upload = async (files: File[]) => {
    for (const file of files) {
      const id = ++counter.current;
      setUploads((u) => [...u, { id, name: file.name, state: "working" }]);
      const form = new FormData();
      form.set("file", file);
      form.set("origin", origin);
      const res = await fetch(`/api/admin/kbs/${kb.id}/docs`, { method: "POST", body: form }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { error?: keyof typeof A.errors } | null;
      const message = res?.ok ? undefined : (A.errors[body?.error ?? "generic"] ?? A.errors.generic);
      setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: res?.ok ? "done" : "error", message } : x)));
      if (res?.ok) await onChanged();
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
      className={`h-9 rounded-lg px-3.5 text-sm ${origin === value ? "bg-ink font-medium text-white" : "text-graphite active:bg-rule"}`}
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
        className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-[18px] border-2 border-dashed px-4 py-8 text-center ${over ? "border-ink bg-mist" : "border-rule"}`}
      >
        <span className="grid h-11 w-11 place-items-center rounded-full bg-ink text-white">
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
                {d.empty > 0 && (
                  <p className="mt-1 flex items-center gap-1.5 text-[13px] text-danger-ink">
                    <WarningIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono">{d.empty}</span>
                    <span>{A.emptyPages}</span>
                  </p>
                )}
              </div>
              <a href={`/api/kbs/${kb.id}/docs/${d.id}/file`} target="_blank" rel="noreferrer" className="rounded-lg px-2.5 py-1.5 text-sm text-graphite active:bg-mist">
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
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/kbs").catch(() => null);
    if (!res) return setError(true);
    if (res.status === 401) {
      // Without a configured password the server refuses in production.
      const probe = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
      return setState(probe?.status === 503 ? "closed" : "login");
    }
    const data = (await res.json()) as { kbs: Kb[]; ai: boolean; accessCode: boolean };
    setKbs(data.kbs);
    setAi(data.ai);
    setAccessCode(data.accessCode);
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
  const link = kb && typeof window !== "undefined" ? `${window.location.origin}/?kb=${kb.id}` : "";

  const call = async (url: string, method: string, body?: object) => {
    setError(false);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (!res?.ok) setError(true);
    return res?.ok ? ((await res.json()) as { kb?: Kb }) : null;
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 pb-10 sm:px-6">
      <header className="flex h-16 items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-[10px] bg-ink">
            <span className="h-3 w-3 rounded-[4px] bg-signal" />
          </span>
          <h1 className="text-lg font-semibold">{A.title}</h1>
        </div>
        <div className="flex items-center gap-1">
          <a href={kb ? `/?kb=${kb.id}` : "/"} className="rounded-xl px-3 py-2 text-[15px] text-graphite active:bg-mist">
            {A.toChat}
          </a>
          <button
            onClick={async () => {
              await fetch("/api/admin/login", { method: "DELETE" }).catch(() => {});
              window.location.reload();
            }}
            className="rounded-xl px-3 py-2 text-[15px] text-graphite active:bg-mist"
          >
            {A.signOut}
          </button>
        </div>
      </header>
      <p className="max-w-2xl pb-5 text-[15px] leading-6 text-graphite">{A.lead}</p>

      <Diagnose />
      {!ai && (
        <p className="mb-5 flex items-start gap-2.5 rounded-[14px] bg-signal-soft px-3.5 py-3 text-[15px] leading-6">
          <WarningIcon className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{A.noAi}</span>
        </p>
      )}
      {error && (
        <p role="alert" className="mb-5 rounded-[14px] border border-danger px-3.5 py-3 text-[15px] text-danger-ink">
          {A.errors.generic}
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <nav aria-label={T.doc.kb} className="flex flex-col gap-2">
          {kbs.map((k) => (
            <button
              key={k.id}
              onClick={() => (setSelected(k.id), setCreating(false), setEditing(false))}
              aria-current={k.id === selected}
              className={`flex flex-col gap-0.5 rounded-[14px] border px-3.5 py-3 text-start ${k.id === selected && !creating ? "border-ink bg-mist" : "border-rule active:bg-mist"}`}
            >
              <span className="text-[15px] font-medium">{k.name}</span>
              <span className="text-[13px] text-stone">
                {k.docs.length ? (
                  <>
                    <span className="font-mono">{k.docs.length}</span> <span>{T.doc.documents}</span>
                  </>
                ) : (
                  T.doc.noDocuments
                )}
              </span>
            </button>
          ))}
          <button onClick={() => setCreating(true)} className="flex h-12 items-center gap-2.5 rounded-[14px] px-3.5 text-[15px] font-medium active:bg-mist">
            <PlusIcon />
            <span>{A.newKb}</span>
          </button>
        </nav>

        <main className="flex min-w-0 flex-col gap-6">
          {creating ? (
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
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-2xl font-semibold leading-8">{kb.name}</h2>
                      {kb.description && <p className="text-[15px] text-graphite">{kb.description}</p>}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setEditing(true)} className="rounded-lg px-3 py-2 text-sm text-graphite active:bg-mist">
                        {A.rename}
                      </button>
                      <button
                        onClick={async () => {
                          if (!window.confirm(A.confirmDeleteKb)) return;
                          if (await call(`/api/admin/kbs/${kb.id}`, "DELETE")) await load();
                        }}
                        className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-danger-ink active:bg-mist"
                      >
                        <CloseIcon className="h-4 w-4" />
                        <span>{A.deleteKb}</span>
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-[14px] bg-mist py-1.5 pe-1.5 ps-3.5">
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
                      className="h-9 shrink-0 rounded-[10px] bg-paper px-3.5 text-sm font-medium"
                    >
                      {copied ? A.copied : A.copy}
                    </button>
                  </div>
                </section>
              )}
              {!accessCode && <p className="text-[13px] leading-5 text-stone">{A.openAccess}</p>}
              <Documents key={kb.id} kb={kb} onChanged={load} />
              <UsageTiles usage={kb.usage} />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
