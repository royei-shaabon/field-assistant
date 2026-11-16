// The implementer's dashboard, the list of environments, and the log of conversations.
// The numbers come from /api/admin/dashboard: two weeks, day by day, per environment.
"use client";

import { useCallback, useEffect, useState } from "react";
import type { DayMetrics, QaRecord } from "@/lib/store/activity";
import type { EnvView } from "@/lib/store/envs";
import { T } from "@/lib/ui-text";
import { CheckIcon, PlusIcon } from "./icons";

const A = T.admin;
const D = A.dash;

type EnvSummary = { env: EnvView; kbs: number; docs: number; days: DayMetrics[] };
type Dash = { master: boolean; days: string[]; envs: EnvSummary[] };

const sum = (days: DayMetrics[], pick: (d: DayMetrics) => number) => days.reduce((n, d) => n + pick(d), 0);
const seconds = (ms: number) => (ms / 1000).toFixed(1);
const dayLabel = (date: string) => `${Number(date.slice(8))}.${Number(date.slice(5, 7))}`;

// The headline numbers of a set of days.
function totals(days: DayMetrics[]) {
  const questions = sum(days, (d) => d.questions);
  const answered = sum(days, (d) => (d.byKind.answer ?? 0) + (d.byKind.spoken ?? 0));
  const timed = sum(days, (d) => d.timed);
  const lookups = sum(days, (d) => d.lookups);
  return {
    questions,
    answered: questions ? Math.round((answered / questions) * 100) : null,
    avg: timed ? sum(days, (d) => d.totalMs) / timed : null,
    first: timed ? sum(days, (d) => d.firstStepMs) / timed : null,
    calls: sum(days, (d) => d.calls),
    lookup: lookups ? Math.round(sum(days, (d) => d.lookupMs) / lookups) : null,
    slow: sum(days, (d) => d.slow),
    errors: sum(days, (d) => d.errors),
  };
}

// Adds up the same day across environments.
function merged(envs: EnvSummary[], dates: string[]): DayMetrics[] {
  return dates.map((date, i) => {
    const days = envs.map((e) => e.days[i]).filter(Boolean);
    const byKind: Record<string, number> = {};
    for (const d of days) for (const [k, v] of Object.entries(d.byKind)) byKind[k] = (byKind[k] ?? 0) + v;
    const add = (pick: (d: DayMetrics) => number) => sum(days, pick);
    return { date, questions: add((d) => d.questions), byKind, byChannel: {}, timed: add((d) => d.timed), totalMs: add((d) => d.totalMs), firstStepMs: add((d) => d.firstStepMs), slow: add((d) => d.slow), lookups: add((d) => d.lookups), lookupMs: add((d) => d.lookupMs), calls: add((d) => d.calls), errors: add((d) => d.errors), helpful: add((d) => d.helpful), unhelpful: add((d) => d.unhelpful) };
  });
}

function Tile({ label, value, unit, tone = "" }: { label: string; value: string | number; unit?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-paper px-5 py-4">
      <dt className="text-[13px] text-stone">{label}</dt>
      <dd className={`font-mono text-[26px] font-medium leading-8 ${tone}`}>
        {value}
        {unit && <span className="ps-1 font-sans text-[13px] font-normal text-stone">{unit}</span>}
      </dd>
    </div>
  );
}

// Questions per day: one series, so one colour and no legend. Each bar names its day and
// number on hover and for a screen reader; the same numbers are in the table under it.
function DayBars({ days }: { days: DayMetrics[] }) {
  const max = Math.max(1, ...days.map((d) => d.questions));
  return (
    <figure className="m-0 flex flex-col gap-2 rounded-[12px] border border-rule bg-paper p-5">
      <figcaption className="text-[15px] font-bold">{D.perDay}</figcaption>
      <div role="img" aria-label={`${D.perDay}: ${days.map((d) => `${dayLabel(d.date)} ${d.questions}`).join(", ")}`} className="flex h-40 items-end gap-[2px] border-b border-rule pt-5">
        {days.map((d) => (
          <div key={d.date} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            <span className="pointer-events-none absolute -top-5 z-10 hidden whitespace-nowrap rounded-[5px] bg-ink px-2 py-0.5 font-mono text-[13px] text-white group-hover:block">
              {dayLabel(d.date)} · {d.questions}
            </span>
            {d.questions === max && d.questions > 0 && <span className="pb-0.5 font-mono text-[13px] text-graphite">{d.questions}</span>}
            <span className="w-full max-w-9 rounded-t-[4px] bg-primary group-hover:bg-primary-strong" style={{ height: `${(d.questions / max) * 82}%`, minHeight: d.questions ? 3 : 0 }} />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex gap-[2px]">
        {days.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 text-center font-mono text-[13px] text-stone">
            {i % 2 === days.length % 2 ? "" : dayLabel(d.date)}
          </span>
        ))}
      </div>
      <details className="pt-1">
        <summary className="cursor-pointer text-[14px] text-graphite">{D.table}</summary>
        <table className="mt-2 w-full text-[14px]">
          <thead>
            <tr className="text-start text-stone">
              <th className="py-1 text-start font-medium">{D.day}</th>
              <th className="py-1 text-start font-medium">{D.questions}</th>
              <th className="py-1 text-start font-medium">{D.avgTime}</th>
              <th className="py-1 text-start font-medium">{D.errors}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-t border-rule-soft font-mono">
                <td className="py-1">{dayLabel(d.date)}</td>
                <td className="py-1">{d.questions}</td>
                <td className="py-1">{d.timed ? seconds(d.totalMs / d.timed) : "–"}</td>
                <td className="py-1">{d.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export function Dashboard() {
  const [data, setData] = useState<Dash | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/admin/dashboard")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setData(d as Dash | null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!data) return <p className="text-[15px] text-stone">{D.loading}</p>;
  const days = merged(data.envs, data.days);
  const t = totals(days);
  return (
    <>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-rule bg-rule lg:grid-cols-4">
        <Tile label={D.questions} value={t.questions} />
        <Tile label={D.answered} value={t.answered ?? "–"} unit={t.answered === null ? undefined : "%"} tone="text-ok" />
        <Tile label={D.avgTime} value={t.avg === null ? "–" : seconds(t.avg)} unit={t.avg === null ? undefined : D.seconds} />
        <Tile label={D.firstStep} value={t.first === null ? "–" : seconds(t.first)} unit={t.first === null ? undefined : D.seconds} />
        <Tile label={D.calls} value={t.calls} />
        <Tile label={D.lookup} value={t.lookup ?? "–"} unit={t.lookup === null ? undefined : D.ms} />
        <Tile label={D.slow} value={t.slow} tone={t.slow ? "text-warn" : ""} />
        <Tile label={D.errors} value={t.errors} tone={t.errors ? "text-danger-ink" : ""} />
      </dl>
      {t.questions === 0 && t.calls === 0 ? <p className="text-[15px] text-stone">{D.none}</p> : <DayBars days={days} />}
      {data.master && data.envs.length > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[17px] font-bold">{D.allEnvs}</h2>
          <div className="overflow-x-auto rounded-[12px] border border-rule bg-paper">
            <table className="w-full min-w-[560px] text-[14px]">
              <thead>
                <tr className="text-stone">
                  {[D.env, D.kbs, D.docs, D.questions, D.answered, D.avgTime, D.errors, ""].map((h, i) => (
                    <th key={i} className="px-4 py-2.5 text-start font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.envs.map((e) => {
                  const x = totals(e.days);
                  return (
                    <tr key={e.env.id} className="border-t border-rule-soft">
                      <td className="px-4 py-2.5 font-semibold">
                        <bdi>{e.env.name}</bdi>
                        {e.env.disabled && <span className="ps-2 text-[13px] font-normal text-stone">{A.envs.disabled}</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono">{e.kbs}</td>
                      <td className="px-4 py-2.5 font-mono">{e.docs}</td>
                      <td className="px-4 py-2.5 font-mono">{x.questions}</td>
                      <td className="px-4 py-2.5 font-mono">{x.answered === null ? "–" : `${x.answered}%`}</td>
                      <td className="px-4 py-2.5 font-mono">{x.avg === null ? "–" : seconds(x.avg)}</td>
                      <td className="px-4 py-2.5 font-mono">{x.errors}</td>
                      <td className="px-4 py-2.5">
                        {!e.env.main && !e.env.disabled && (
                          <a href={`/e/${e.env.id}/admin`} className="font-medium text-primary underline underline-offset-4">
                            {D.open}
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

const FIELD = "h-11 rounded-[8px] border border-edge bg-paper px-3 text-base font-normal text-ink focus:border-primary";
const LABEL = "flex flex-col gap-1.5 text-sm font-medium text-graphite";

// The main administrator's list of environments: create one, hand out its two links, replace
// its password or its technicians' code, or switch it off. Passwords are never shown again.
export function Environments() {
  const [envs, setEnvs] = useState<EnvView[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", adminPassword: "", accessCode: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/envs").catch(() => null);
    if (res?.ok) setEnvs(((await res.json()) as { envs: EnvView[] }).envs);
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  const fail = async (res: Response | null) => {
    const error = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error as keyof typeof A.envs.errors | undefined;
    setProblem(A.envs.errors[error ?? "generic"] ?? A.envs.errors.generic);
  };
  const change = async (id: string, body: object) => {
    setProblem(null);
    setSaved(null);
    const res = await fetch(`/api/admin/envs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!res?.ok) return fail(res);
    setSaved(id);
    await load();
  };
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  if (!envs) return <p className="text-[15px] text-stone">{D.loading}</p>;
  return (
    <>
      {problem && (
        <p role="alert" className="rounded-[10px] border border-danger px-3.5 py-3 text-[15px] text-danger-ink">
          {problem}
        </p>
      )}
      {creating ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setProblem(null);
            const res = await fetch("/api/admin/envs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }).catch(() => null);
            if (!res?.ok) return fail(res);
            setForm({ id: "", name: "", adminPassword: "", accessCode: "" });
            setCreating(false);
            await load();
          }}
          className="flex flex-col gap-3 rounded-[12px] border border-rule bg-paper p-5"
        >
          <label className={LABEL}>
            <span>{A.envs.name}</span>
            <input autoFocus value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>{A.envs.id}</span>
            <input dir="ltr" value={form.id} maxLength={40} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="electra" className={`${FIELD} font-mono`} />
          </label>
          <label className={LABEL}>
            <span>{A.envs.adminPassword}</span>
            <input dir="ltr" type="password" autoComplete="new-password" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>{A.envs.accessCode}</span>
            <input dir="ltr" autoComplete="off" value={form.accessCode} onChange={(e) => setForm({ ...form, accessCode: e.target.value })} className={FIELD} />
          </label>
          <div className="flex gap-2">
            <button disabled={!form.name.trim() || !form.id || form.adminPassword.length < 8} className="h-11 rounded-[9px] bg-primary px-5 text-[15px] font-medium text-white disabled:opacity-40">
              {A.envs.submit}
            </button>
            <button type="button" onClick={() => setCreating(false)} className="h-11 rounded-[9px] px-4 text-[15px] text-graphite hover:bg-mist">
              {A.cancel}
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setCreating(true)} className="flex h-11 items-center gap-2 self-start rounded-[9px] bg-primary px-4 text-[15px] font-medium text-white hover:bg-primary-strong">
          <PlusIcon className="h-5 w-5" />
          <span>{A.envs.create}</span>
        </button>
      )}
      <ul className="flex flex-col gap-3">
        {envs.map((e) => (
          <li key={e.id} className="flex flex-col gap-3 rounded-[12px] border border-rule bg-paper p-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-[18px] font-bold">
                <bdi>{e.name}</bdi>
              </h2>
              <span dir="ltr" className="font-mono text-[13px] text-stone">
                {e.id}
              </span>
              {e.main && <span className="rounded-[5px] border border-rule px-2 py-0.5 text-[13px] text-graphite">{A.envs.main}</span>}
              {e.disabled && <span className="rounded-[5px] bg-signal-soft px-2 py-0.5 text-[13px] text-warn">{A.envs.disabled}</span>}
              {!e.main && <span className="text-[13px] text-stone">{e.hasAccessCode ? A.envs.withCode : A.envs.noCode}</span>}
              {saved === e.id && (
                <span role="status" className="flex items-center gap-1 text-[13px] text-ok">
                  <CheckIcon className="h-4 w-4" />
                  {A.envs.saved}
                </span>
              )}
            </div>
            <dl className="grid gap-1.5 text-[14px]">
              {[
                [A.envs.technician, e.main ? `${origin}/` : `${origin}/e/${e.id}`],
                [A.envs.admin, e.main ? `${origin}/admin` : `${origin}/e/${e.id}/admin`],
              ].map(([label, url]) => (
                <div key={label} className="flex flex-wrap items-center gap-x-3">
                  <dt className="w-36 shrink-0 text-stone">{label}</dt>
                  <dd className="min-w-0">
                    <a href={url} dir="ltr" className="break-all font-mono text-[13px] text-primary underline underline-offset-4">
                      {url}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
            {!e.main && <EnvSecrets env={e} onChange={(body) => change(e.id, body)} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function EnvSecrets({ env, onChange }: { env: EnvView; onChange: (body: object) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-rule-soft pt-3">
      <label className={LABEL}>
        <span>{A.envs.newPassword}</span>
        <input dir="ltr" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${FIELD} w-52`} />
      </label>
      <button disabled={password.length < 8} onClick={() => onChange({ adminPassword: password }).then(() => setPassword(""))} className="h-11 rounded-[8px] border border-edge px-3.5 text-sm font-medium hover:bg-mist disabled:opacity-40">
        {A.envs.setPassword}
      </button>
      <label className={LABEL}>
        <span>{A.envs.newCode}</span>
        <input dir="ltr" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} className={`${FIELD} w-44`} />
      </label>
      <button onClick={() => onChange({ accessCode: code }).then(() => setCode(""))} className="h-11 rounded-[8px] border border-edge px-3.5 text-sm font-medium hover:bg-mist">
        {A.envs.setCode}
      </button>
      <button
        onClick={() => {
          if (!env.disabled && !window.confirm(A.envs.confirmDisable)) return;
          void onChange({ disabled: !env.disabled });
        }}
        className={`ms-auto h-11 rounded-[8px] px-3.5 text-sm font-medium hover:bg-mist ${env.disabled ? "text-primary" : "text-danger-ink"}`}
      >
        {env.disabled ? A.envs.enable : A.envs.disable}
      </button>
    </div>
  );
}

// What technicians asked and what they got, newest first.
export function Conversations() {
  const [records, setRecords] = useState<QaRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/admin/conversations?days=14")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setRecords((d as { records: QaRecord[] } | null)?.records ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!records) return <p className="text-[15px] text-stone">{D.loading}</p>;
  if (!records.length) return <p className="text-[15px] text-stone">{A.talks.none}</p>;
  const kinds = A.talks.kind as Record<string, string>;
  return (
    <ul className="flex flex-col gap-2">
      {records.map((r) => (
        <li key={r.id} className="rounded-[12px] border border-rule bg-paper">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1 text-[15px] font-medium">
                <bdi>{r.question || A.talks.noWords}</bdi>
              </span>
              <span className={`text-[13px] ${r.kind === "error" ? "text-danger-ink" : r.kind === "answer" || r.kind === "spoken" ? "text-ok" : "text-graphite"}`}>{kinds[r.kind] ?? r.kind}</span>
              <span className="text-[13px] text-stone">{A.talks.channel[r.channel]}</span>
              {r.ms !== undefined && (
                <span className="font-mono text-[13px] text-stone">
                  {seconds(r.ms)} {D.seconds}
                </span>
              )}
              <span className="font-mono text-[13px] text-stone">{new Date(r.at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}</span>
            </summary>
            <div className="flex flex-col gap-2 border-t border-rule-soft px-4 py-3 text-[15px] leading-6">
              <p className="text-[13px] text-stone">
                <bdi>{r.kbName ?? r.kbId}</bdi>
                {r.removedAt && <span className="ps-2 text-warn">· {A.talks.removed}</span>}
              </p>
              {r.title && <p className="font-semibold">{r.title}</p>}
              {r.steps && (
                <ol className="list-decimal ps-5">
                  {r.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {r.ideas && (
                <div>
                  <p className="text-[13px] text-stone">{A.talks.ideas}</p>
                  <ul className="list-disc ps-5">
                    {r.ideas.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {r.sources?.length ? (
                <p className="text-[13px] text-stone">
                  <bdi>{r.sources.join(" | ")}</bdi>
                </p>
              ) : null}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
