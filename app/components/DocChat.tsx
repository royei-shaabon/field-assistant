// Chat views for document knowledge bases: an answer whose steps were each verified against
// their source, a clarifying question, "not in the documents", and the hazard stop.
"use client";

import type { DocMark, HazardTopic, SourceView } from "@/lib/docs/ask";
import type { ChatItem } from "@/lib/screen";
import { T } from "@/lib/ui-text";
import { MarkedImage, Reveal, WORD_MS, wordCount } from "./Chat";
import { DocIcon, WarningIcon } from "./icons";

type Answer = Extract<ChatItem, { kind: "doc_answer" }>;

// Opens the original document; a PDF opens at the cited page.
export function sourceHref(kbId: string, s: SourceView): string {
  return `/api/kbs/${kbId}/docs/${s.docId}/file${s.unit === "page" ? `#page=${s.n}` : ""}`;
}

export function SourceLink({ kbId, source, dark = false }: { kbId: string; source: SourceView; dark?: boolean }) {
  return (
    <a
      href={sourceHref(kbId, source)}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-lg px-2.5 py-1 text-[12.5px] ${dark ? "bg-white/12 text-white" : "bg-mist text-graphite active:bg-rule"}`}
    >
      <DocIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{source.docName}</span>
      <span className="shrink-0">{source.unit === "page" ? T.doc.page : T.doc.part}</span>
      <span className="shrink-0 font-mono">{source.n}</span>
    </a>
  );
}

const sameSource = (a: SourceView, b: SourceView) => a.docId === b.docId && a.n === b.n;

export function docAnswerWords(item: Answer): number {
  return wordCount(item.title) + item.steps.reduce((n, s) => n + wordCount(s.text), 0);
}

function Marks({ marks, frames }: { marks: DocMark[]; frames?: string[] }) {
  if (!marks.length) return null;
  const numbered = marks.map((m, i) => ({ ...m, n: i + 1, symptomTitle: "" }));
  const used = [...new Set(marks.map((m) => m.frame))].sort((a, b) => a - b);
  return (
    <figure className="anim-rise m-0 flex flex-col gap-2">
      <figcaption className="text-xs font-medium text-stone">{T.doc.inPhoto}</figcaption>
      {used.map((f) => (
        <MarkedImage key={f} src={frames?.[f]} marks={numbered.filter((m) => m.frame === f)} />
      ))}
      <ol className="flex flex-wrap gap-x-4 gap-y-1">
        {numbered.map((m) => (
          <li key={m.n} className="flex items-center gap-1.5 text-sm text-ink-soft">
            <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-signal font-mono text-[10px] font-medium text-ink">{m.n}</span>
            <span>{m.label}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export function DocAnswer({ item, kbId, frames, animate, delay }: { item: Answer; kbId: string; frames?: string[]; animate: boolean; delay: number }) {
  // One source for the whole answer is shown once, under the steps.
  const single = item.steps.every((s) => sameSource(s.source, item.steps[0].source));
  // When each step starts typing: after the title and the steps before it.
  const starts = item.steps.reduce<number[]>((list, s, i) => [...list, (list[i - 1] ?? delay + wordCount(item.title) * WORD_MS) + (i ? wordCount(item.steps[i - 1].text) * WORD_MS : 0)], []);
  return (
    <article className="flex flex-col gap-3.5">
      {item.caution && (
        <div role="alert" className="overflow-hidden rounded-[16px] bg-ink text-white">
          <div className="hazard-stripe h-2" />
          <div className="flex gap-2.5 px-3.5 py-3">
            <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-signal" />
            <div className="flex flex-col gap-0.5">
              <p className="text-[15px] font-semibold leading-[22px]">
                <span>{T.doc.cautionTitle}</span> <span className="text-signal">{T.doc.topics[item.caution]}</span>
              </p>
              <p className="text-sm leading-[21px] text-[#c9c9c4]">{T.doc.cautionBody}</p>
            </div>
          </div>
        </div>
      )}
      <Marks marks={item.marks} frames={frames} />
      <h3 className="text-[19px] font-semibold leading-[26px]">
        <Reveal text={item.title} animate={animate} delay={delay} />
      </h3>
      <ol className="flex flex-col gap-3.5">
        {item.steps.map((step, i) => {
          const stepDelay = starts[i];
          const marked = item.marks.flatMap((m, n) => (m.step === i ? [n + 1] : []));
          return (
            <li key={i} className="flex gap-3">
              {item.steps.length > 1 && (
                <span aria-hidden className="mt-[3px] grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-ink font-mono text-[11px] text-white">
                  {i + 1}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="text-[17px] leading-[26px]">
                  <Reveal text={step.text} animate={animate} delay={stepDelay} />
                  {marked.map((n) => (
                    <span key={n} className="ms-1.5 inline-grid h-[18px] w-[18px] translate-y-[-1px] place-items-center rounded-full bg-signal font-mono text-[10px] font-medium text-ink">
                      {n}
                    </span>
                  ))}
                </p>
                <details className="group text-[13px] text-stone">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden">
                    {!single && <SourceLink kbId={kbId} source={step.source} />}
                    <span className="underline decoration-rule underline-offset-4 group-open:text-ink">{T.doc.original}</span>
                  </summary>
                  <blockquote dir="auto" className="mt-1.5 border-s-2 border-rule ps-3 text-sm leading-[21px] text-graphite">
                    {step.quote}
                  </blockquote>
                </details>
              </div>
            </li>
          );
        })}
      </ol>
      {single && <SourceLink kbId={kbId} source={item.steps[0].source} />}
    </article>
  );
}

export function DocAsk({ item, interactive, animate, delay, onOption }: { item: Extract<ChatItem, { kind: "doc_ask" }>; interactive: boolean; animate: boolean; delay: number; onOption?: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[19px] font-semibold leading-[27px]">
        <Reveal text={item.question} animate={animate} delay={delay} />
      </p>
      {interactive && item.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {item.options.map((o) => (
            <button key={o} onClick={() => onOption?.(o)} className="min-h-11 rounded-[14px] border border-rule bg-paper px-4 py-2 text-start text-base active:bg-mist">
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocHazard({ topic, sources, kbId }: { topic: HazardTopic; sources: SourceView[]; kbId: string }) {
  return (
    <section role="alert" className="overflow-hidden rounded-[18px] bg-ink text-white">
      <div className="hazard-stripe h-2.5" />
      <div className="flex flex-col gap-2.5 px-[18px] pb-5 pt-[18px]">
        <div className="flex items-center gap-2.5">
          <WarningIcon className="h-[26px] w-[26px] text-signal" />
          <p className="text-2xl font-semibold leading-[30px]">{T.stop.title}</p>
        </div>
        <p className="text-sm font-medium text-signal">{T.doc.topics[topic]}</p>
        <p className="text-[17px] leading-[26px]">{T.doc.hazardBody}</p>
        <p className="text-sm leading-[21px] text-[#c9c9c4]">{sources.length ? T.doc.hazardSources : T.doc.hazardNoSources}</p>
        {sources.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {sources.map((s) => (
              <SourceLink key={`${s.docId}:${s.n}`} kbId={kbId} source={s} dark />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function DocNote({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[17px] leading-[26px]">{title}</p>
      {hint && <p className="text-sm leading-[21px] text-stone">{hint}</p>}
    </div>
  );
}
