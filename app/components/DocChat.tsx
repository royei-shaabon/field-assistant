// Chat views for document knowledge bases: an answer whose steps were each verified against
// their source, a clarifying question, "not in the documents", and the hazard stop.
"use client";

import { useState } from "react";
import type { DocFigure, DocMark, HazardTopic, SourceView } from "@/lib/docs/ask";
import type { ChatItem } from "@/lib/screen";
import { T } from "@/lib/ui-text";
import { MarkedImage, Mixed, Reveal, WORD_MS, wordCount } from "./Chat";
import { ArrowIcon, DocIcon, WarningIcon } from "./icons";

type Answer = Extract<ChatItem, { kind: "doc_answer" }>;

// Opens the original document; a PDF opens at the cited page.
export function sourceHref(kbId: string, s: SourceView): string {
  return `/api/kbs/${kbId}/docs/${s.docId}/file${s.unit === "page" ? `#page=${s.n}` : ""}`;
}

// The source is what makes an answer trustworthy, so it is a full-width row, not a small chip.
export function SourceLink({ kbId, source, dark = false }: { kbId: string; source: SourceView; dark?: boolean }) {
  return (
    <a
      href={sourceHref(kbId, source)}
      target="_blank"
      rel="noreferrer"
      className={`flex min-h-12 items-center gap-2.5 rounded-[14px] border px-3.5 py-2 text-[15px] ${dark ? "border-white/40 text-white" : "border-edge text-ink active:bg-mist"}`}
    >
      <DocIcon className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{T.doc.openSource}</span>
        <span className={`block truncate text-[13px] ${dark ? "text-white/75" : "text-graphite"}`}>
          <bdi>{source.docName}</bdi> <span>·</span> <span>{source.unit === "page" ? T.doc.page : T.doc.part}</span> <span className="font-mono">{source.n}</span>
        </span>
      </span>
      <ArrowIcon className="h-4 w-4 shrink-0 rtl:rotate-180" />
    </a>
  );
}

const sameSource = (a: SourceView, b: SourceView) => a.docId === b.docId && a.n === b.n;
const isHebrew = (text: string) => /[֐-׿]/.test(text);

export function docAnswerWords(item: Answer): number {
  return wordCount(item.title) + item.steps.reduce((n, s) => n + wordCount(s.text), 0);
}

export function MarksLegend({ marks }: { marks: DocMark[] }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1.5">
      {marks.map((m, i) => (
        <li key={i} className="flex items-center gap-2 text-[15px]">
          <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-signal font-mono text-[13px] font-medium text-ink">
            {i + 1}
          </span>
          <span>{m.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Marks({ marks, frames }: { marks: DocMark[]; frames?: string[] }) {
  if (!marks.length) return null;
  const numbered = marks.map((m, i) => ({ ...m, n: i + 1, symptomTitle: "" }));
  const used = [...new Set(marks.map((m) => m.frame))].sort((a, b) => a - b);
  return (
    <figure className="anim-rise m-0 flex flex-col gap-2">
      <figcaption className="text-sm font-medium text-graphite">{T.doc.inPhoto}</figcaption>
      {used.map((f) => (
        <MarkedImage key={f} src={frames?.[f]} marks={numbered.filter((m) => m.frame === f)} />
      ))}
      <MarksLegend marks={marks} />
    </figure>
  );
}

// A drawing from the manual, cut out of the page picture. Tapping opens the whole page.
function Figure({ kbId, figure }: { kbId: string; figure: DocFigure }) {
  const { box, source, aspect } = figure;
  const page = `/api/kbs/${kbId}/docs/${source.docId}/page/${source.n}`;
  // A little air around the box, so a label at its edge is not cut.
  const pad = 15;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(1000 - x, box.w + 2 * pad);
  const h = Math.min(1000 - y, box.h + 2 * pad);
  return (
    <figure className="anim-rise m-0 flex flex-col gap-1.5">
      <a href={page} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-edge bg-white">
        <span
          role="img"
          aria-label={figure.caption || T.doc.figure}
          className="block w-full"
          style={{
            aspectRatio: `${w * aspect} / ${h}`,
            backgroundImage: `url(${page})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${(1000 / w) * 100}% auto`,
            backgroundPosition: `${w >= 1000 ? 0 : (x / (1000 - w)) * 100}% ${h >= 1000 ? 0 : (y / (1000 - h)) * 100}%`,
          }}
        />
      </a>
      <figcaption className="text-[15px] text-graphite">
        <span>{T.doc.figure}</span>
        {figure.caption && <span>: {figure.caption}</span>}
      </figcaption>
    </figure>
  );
}

// "Helped" / "did not help": only a count reaches the server.
function Feedback({ kbId }: { kbId: string }) {
  const [sent, setSent] = useState(false);
  const send = (helpful: boolean) => {
    setSent(true);
    void fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbId, helpful }) }).catch(() => {});
  };
  if (sent) {
    return (
      <p role="status" className="text-[15px] text-graphite">
        {T.doc.feedbackThanks}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-[15px] text-graphite">{T.doc.feedbackAsk}</span>
      <button onClick={() => send(true)} className="h-11 rounded-xl border border-edge px-4 text-[15px] font-medium active:bg-mist">
        {T.doc.helped}
      </button>
      <button onClick={() => send(false)} className="h-11 rounded-xl border border-edge px-4 text-[15px] font-medium active:bg-mist">
        {T.doc.notHelped}
      </button>
    </div>
  );
}

function Caution({ topic }: { topic: HazardTopic }) {
  return (
    <div role="alert" className="on-dark overflow-hidden rounded-[16px] bg-ink text-white">
      <div className="hazard-stripe h-2" />
      <div className="flex gap-2.5 px-3.5 py-3">
        <WarningIcon className="mt-0.5 h-6 w-6 shrink-0 text-signal" />
        <div className="flex flex-col gap-0.5">
          <p className="text-[17px] font-semibold leading-6">
            <span>{T.doc.cautionTitle}</span> <span className="text-signal">{T.doc.topics[topic]}</span>
          </p>
          <p className="text-[15px] leading-[22px] text-[#c9c9c4]">{T.doc.cautionBody}</p>
        </div>
      </div>
    </div>
  );
}

export function DocAnswer({
  item,
  kbId,
  frames,
  animate,
  delay,
  feedback = false,
  writing = false,
}: {
  item: Answer;
  kbId: string;
  frames?: string[];
  animate: boolean;
  delay: number;
  // Offered on an answer that has just arrived, not on old ones in a reopened conversation.
  feedback?: boolean;
  // Still being written: more steps are on the way, and there is nothing to rate yet.
  writing?: boolean;
}) {
  // One source for the whole answer is shown once, under the steps.
  const single = item.steps.every((s) => sameSource(s.source, item.steps[0].source));
  // When each step starts typing: after the title and the steps before it.
  // The manual's own wording, for every step at once: one switch, not a link under each step.
  const [quotes, setQuotes] = useState(false);
  const starts = item.steps.reduce<number[]>((list, s, i) => [...list, (list[i - 1] ?? delay + wordCount(item.title) * WORD_MS) + (i ? wordCount(item.steps[i - 1].text) * WORD_MS : 0)], []);
  return (
    <article className="flex flex-col gap-4">
      {item.caution && <Caution topic={item.caution} />}
      <Marks marks={item.marks} frames={frames} />
      <h2 className="text-[21px] font-semibold leading-7">
        <Reveal text={item.title} animate={animate} delay={delay} mixed />
      </h2>
      <ol className="flex flex-col gap-4">
        {item.steps.map((step, i) => {
          const marked = item.marks.flatMap((m, n) => (m.step === i ? [n + 1] : []));
          return (
            <li key={i} className="flex gap-3">
              {item.steps.length > 1 && (
                <span aria-hidden className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink font-mono text-sm text-white">
                  {i + 1}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="text-[18px] leading-7">
                  <Reveal text={step.text} animate={animate} delay={starts[i]} mixed />
                  {marked.map((n) => (
                    <span key={n} aria-hidden className="ms-1.5 inline-grid h-5 w-5 translate-y-[-1px] place-items-center rounded-full bg-signal font-mono text-xs font-medium text-ink">
                      {n}
                    </span>
                  ))}
                </p>
                {quotes && (
                  <blockquote dir="auto" lang={isHebrew(step.quote) ? "he" : "en"} className="border-s-[3px] border-edge ps-3 text-[15px] leading-[23px] text-graphite">
                    {step.quote}
                  </blockquote>
                )}
                {!single && !writing && <SourceLink kbId={kbId} source={step.source} />}
              </div>
            </li>
          );
        })}
      </ol>
      {!writing && item.figures?.map((f, i) => <Figure key={i} kbId={kbId} figure={f} />)}
      {!writing && (
        <button onClick={() => setQuotes((q) => !q)} aria-expanded={quotes} className="flex min-h-11 items-center gap-2 self-start text-[15px] text-graphite">
          <ArrowIcon className={`h-3.5 w-3.5 transition-transform ${quotes ? "-rotate-90" : "rotate-90"}`} />
          <span className="underline decoration-stone underline-offset-4">{quotes ? T.doc.hideOriginal : T.doc.original}</span>
        </button>
      )}
      {!writing && single && <SourceLink kbId={kbId} source={item.steps[0].source} />}
      {!writing && feedback && <Feedback kbId={kbId} />}
    </article>
  );
}

export function DocAsk({ item, interactive, animate, delay, onOption }: { item: Extract<ChatItem, { kind: "doc_ask" }>; interactive: boolean; animate: boolean; delay: number; onOption?: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[21px] font-semibold leading-[29px]">
        <Reveal text={item.question} animate={animate} delay={delay} mixed />
      </p>
      {interactive && item.options.length > 0 && (
        <div className="flex flex-col gap-2">
          {item.options.map((o) => (
            <button key={o} onClick={() => onOption?.(o)} className="min-h-[52px] rounded-[14px] border border-edge bg-paper px-4 py-2.5 text-start text-[17px] active:bg-mist">
              <Mixed text={o} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocHazard({ topic, sources, kbId }: { topic: HazardTopic; sources: SourceView[]; kbId: string }) {
  return (
    <section role="alert" className="on-dark overflow-hidden rounded-[18px] bg-ink text-white">
      <div className="hazard-stripe h-2.5" />
      <div className="flex flex-col gap-2.5 px-[18px] pb-5 pt-[18px]">
        <div className="flex items-center gap-2.5">
          <WarningIcon className="h-[26px] w-[26px] text-signal" />
          <h2 className="text-2xl font-semibold leading-[30px]">{T.stop.title}</h2>
        </div>
        <p className="text-[15px] font-medium text-signal">{T.doc.topics[topic]}</p>
        <p className="text-[17px] leading-[26px]">{T.doc.hazardBody}</p>
        <p className="text-[15px] leading-[22px] text-[#c9c9c4]">{sources.length ? T.doc.hazardSources : T.doc.hazardNoSources}</p>
        {sources.map((s) => (
          <SourceLink key={`${s.docId}:${s.n}`} kbId={kbId} source={s} dark />
        ))}
        <p className="text-[15px] leading-[22px] text-[#c9c9c4]">{T.doc.hazardUnqualified}</p>
      </div>
    </section>
  );
}

export function DocNote({ title, hint, actions = [] }: { title: string; hint?: string; actions?: { label: string; run?: () => void }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[18px] leading-7">{title}</p>
      {hint && <p className="text-[15px] leading-[23px] text-graphite">{hint}</p>}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {actions.map((a) => (
            <button key={a.label} onClick={a.run} className="h-12 rounded-[14px] border border-edge px-4 text-base font-medium active:bg-mist">
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
