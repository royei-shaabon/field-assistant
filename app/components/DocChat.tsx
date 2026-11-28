// Chat views for document knowledge bases: an answer whose steps were each verified against
// their source, a clarifying question, "not in the documents", and the hazard stop.
"use client";

import { useEffect, useState } from "react";
import type { DocFigure, DocIdea, DocMark, HazardTopic, SourceView } from "@/lib/docs/ask";
import type { ChatItem } from "@/lib/screen";
import { T } from "@/lib/ui-text";
import { BotBubble, MarkedImage, Mixed, Reveal, Typed, CHAR_MS, charCount } from "./Chat";
import { ArrowIcon, DocIcon, WarningIcon } from "./icons";

type Answer = Extract<ChatItem, { kind: "doc_answer" }>;

// Opens the original document; a PDF opens at the cited page.
export function sourceHref(kbId: string, s: SourceView): string {
  return `/api/kbs/${kbId}/docs/${s.docId}/file${s.unit === "page" ? `#page=${s.n}` : ""}`;
}

// The source is what makes an answer trustworthy. It looks like a document sent in a chat:
// a file tile with its name and page, and a tap opens it.
export function SourceLink({ kbId, source, pages, dark = false }: { kbId: string; source: SourceView; pages?: number[]; dark?: boolean }) {
  // One tile per document: every page the answer leans on is named in it, and a tap opens the first.
  const list = pages?.length ? pages : [source.n];
  // Which pages, and of which model years: this part is never cut, however long the manual's name is.
  const pages_ = (
    <>
      {source.years && (
        <>
          <span>
            {T.doc.sourceYears} <span className="font-mono">{source.years}</span>
          </span>{" "}
          <span>·</span>{" "}
        </>
      )}
      <span>{source.unit === "page" ? T.doc.page : T.doc.part}</span>{" "}
      {/* Left to right, so "74, 75" is not turned round inside a Hebrew line. */}
      <bdi dir="ltr" className="font-mono">
        {list.join(", ")}
      </bdi>
    </>
  );
  const where = (
    <>
      <bdi>{source.docName}</bdi> <span>·</span> {pages_}
    </>
  );
  // On the dark stop card the source is the only thing to do, so it stays a full tile.
  if (dark) {
    return (
      <a href={sourceHref(kbId, { ...source, n: list[0] })} target="_blank" rel="noopener" className="flex min-h-12 items-center gap-3 rounded-[10px] border border-white/40 px-2 py-1.5 text-[15px] text-white">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] bg-white/15">
          <DocIcon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{T.doc.openSource}</span>
          <span className="block truncate text-[13px] text-white/75">{where}</span>
        </span>
        <ArrowIcon className="h-4 w-4 shrink-0 rtl:rotate-180" />
      </a>
    );
  }
  // Under an answer the source is a quiet line: which manual and which pages, and a small button that opens it.
  return (
    <p className="flex items-center gap-2.5 text-[13px] leading-5 text-graphite">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          <span>{T.doc.sourceLabel}</span> <bdi>{source.docName}</bdi>
        </span>
        <span>{pages_}</span>
        {/* A model read this page from its picture: said on its own line, so it is never cut off. */}
        {source.read && <span>{T.doc.sourceRead}</span>}
        {/* Field experience of the customer's own team, approved by the implementer: never shown as the manufacturer's word. */}
        {source.origin === "team" && <span>{T.doc.sourceTeam}</span>}
      </span>
      <a
        href={sourceHref(kbId, { ...source, n: list[0] })}
        target="_blank"
        rel="noopener"
        aria-label={`${T.doc.openSource}: ${source.docName}`}
        className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] border border-edge px-2.5 text-[13px] font-medium text-primary active:bg-mist after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']"
      >
        <DocIcon className="h-4 w-4" />
        <span>{T.doc.openShort}</span>
      </a>
    </p>
  );
}

// The documents an answer leans on, each once, with its pages in order.
export function answerSources(steps: { source: SourceView }[]): { source: SourceView; pages: number[] }[] {
  const byDoc = new Map<string, { source: SourceView; pages: number[] }>();
  for (const { source } of steps) {
    const entry = byDoc.get(source.docId) ?? { source, pages: [] };
    // One step that leans on a page read from its picture marks the whole line.
    if (source.read && !entry.source.read) entry.source = { ...entry.source, read: true };
    if (!entry.pages.includes(source.n)) entry.pages.push(source.n);
    byDoc.set(source.docId, entry);
  }
  return [...byDoc.values()].map((e) => ({ ...e, pages: [...e.pages].sort((a, b) => a - b) }));
}

const isHebrew = (text: string) => /[֐-׿]/.test(text);

// The letter the answer had reached while it was still arriving, for the whole answer that replaces it.
const written = { n: 0 };

export function docAnswerChars(item: Answer): number {
  return charCount(item.title) + item.steps.reduce((n, s) => n + charCount(s.text), 0);
}

export function MarksLegend({ marks }: { marks: DocMark[] }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1.5">
      {marks.map((m, i) => (
        <li key={i} className="flex items-center gap-2 text-[15px]">
          <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-signal font-mono text-[13px] font-medium text-night">
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
  // The page picture takes a second or two the first time. Until it is there the frame is a
  // quiet placeholder, and no mark is drawn on an empty frame.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setLoaded(true);
    img.src = page;
    return () => {
      img.onload = null;
    };
  }, [page]);
  const marked = loaded ? (figure.parts ?? []).filter((p) => p.asked) : [];
  // What the drawing prints, next to the same part's name in the technician's language.
  const printed = (figure.parts ?? []).filter((p) => p.printed);
  return (
    <figure className="anim-rise m-0 flex flex-col gap-1.5">
      <a href={page} target="_blank" rel="noopener" aria-busy={!loaded} className={`relative block overflow-hidden rounded-2xl border border-edge ${loaded ? "bg-white" : "bg-mist"}`}>
        <span
          role="img"
          aria-label={[figure.caption || T.doc.figure, ...marked.map((m) => m.name)].join(", ")}
          className="block w-full"
          style={{
            aspectRatio: `${w * aspect} / ${h}`,
            backgroundImage: loaded ? `url(${page})` : undefined,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${(1000 / w) * 100}% auto`,
            backgroundPosition: `${w >= 1000 ? 0 : (x / (1000 - w)) * 100}% ${h >= 1000 ? 0 : (y / (1000 - h)) * 100}%`,
          }}
        />
        {/* The part being talked about, marked on the manual's own drawing with its name. */}
        {marked.map((m, i) => {
          const left = ((m.box.x - x) / w) * 100;
          const top = ((m.box.y - y) / h) * 100;
          return (
            <span key={i} aria-hidden>
              <span
                className="absolute rounded-lg border-[3px] border-signal shadow-[0_0_0_1.5px_var(--color-night),inset_0_0_0_1.5px_var(--color-night)]"
                style={{ left: `${left}%`, top: `${top}%`, width: `${(m.box.w / w) * 100}%`, height: `${(m.box.h / h) * 100}%` }}
              />
              <span
                className="absolute max-w-[70%] truncate rounded-md bg-signal px-1.5 py-0.5 text-[13px] font-medium leading-[18px] text-night shadow-[0_0_0_1.5px_var(--color-night)]"
                style={top > 18 ? { left: `${Math.min(left, 60)}%`, bottom: `${100 - top + 1.5}%` } : { left: `${Math.min(left, 60)}%`, top: `${top + (m.box.h / h) * 100 + 1.5}%` }}
              >
                {m.name}
              </span>
            </span>
          );
        })}
      </a>
      <figcaption className="text-[15px] text-graphite">
        <span>{T.doc.figure}</span>
        {figure.caption && <span>: {figure.caption}</span>}
        {printed.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 text-[14px] leading-[20px]" aria-label={T.doc.figureWords}>
            {printed.map((p, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                <bdi lang="en" className="font-mono text-[13px] text-stone">{p.printed}</bdi>
                <span aria-hidden className="text-stone">·</span>
                <span className="text-ink">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
      </figcaption>
    </figure>
  );
}

// A suggested reply under a message: a tap sends it or starts an action.
// Looks 40px tall, like a reply chip in any chat; the tap area is 48px.
export const CHIP = "relative flex h-10 items-center gap-2 rounded-[7px] border border-edge bg-mist px-3.5 text-[15px] font-medium text-ink active:bg-rule-soft after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']";

export function QuickReplies({ actions }: { actions: { label: string; run?: () => void }[] }) {
  if (!actions.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pt-1">
      {actions.map((a) => (
        <button key={a.label} onClick={a.run} className={CHIP}>
          <Mixed text={a.label} />
        </button>
      ))}
    </div>
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
      <p role="status" className="px-1 text-[15px] text-graphite">
        {T.doc.feedbackThanks}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
      <span className="text-[14px] text-stone">{T.doc.feedbackAsk}</span>
      <button onClick={() => send(true)} className={CHIP}>
        {T.doc.helped}
      </button>
      <button onClick={() => send(false)} className={CHIP}>
        {T.doc.notHelped}
      </button>
    </div>
  );
}

export function Caution({ topic }: { topic: HazardTopic }) {
  // The manufacturer's own notice, for a qualified audience: one quiet line, not a card.
  if (topic === "maker") {
    return (
      <p role="note" className="flex items-center gap-2 text-[14px] leading-5 text-graphite">
        <WarningIcon className="h-4 w-4 shrink-0 text-warn" />
        <span>{T.doc.makerNotice}</span>
      </p>
    );
  }
  return (
    <div role="alert" className="flex gap-2.5 rounded-[10px] border border-signal bg-signal-soft px-3.5 py-3">
      <WarningIcon className="mt-0.5 h-6 w-6 shrink-0 text-warn" />
      <div className="flex flex-col gap-0.5">
        <p className="text-[16px] font-bold leading-6 text-ink">
          <span>{T.doc.cautionTitle}</span> <span className="text-warn">{T.doc.topics[topic]}</span>
        </p>
        <p className="text-[15px] leading-[22px] text-ink-soft">{T.doc.cautionBody}</p>
      </div>
    </div>
  );
}

// Checks from the model's general knowledge: a message of their own, always under this heading
// and badge, so nobody takes them for the manual's instructions. The order was set by the server.
export function Ideas({ ideas, time }: { ideas: DocIdea[]; time?: string }) {
  return (
    <BotBubble wide time={time}>
      <section aria-label={`${T.doc.ideasTitle}, ${T.doc.ideasBadge}`} className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[16px] font-bold text-ink">{T.doc.ideasTitle}</h3>
          <span className="rounded-[5px] border border-rule px-2 py-0.5 text-[13px] font-medium text-graphite">{T.doc.ideasBadge}</span>
        </div>
        <p className="text-[14px] leading-[20px] text-stone">{T.doc.ideasLead}</p>
        <ol className="flex flex-col">
          {ideas.map((idea, i) => (
            <li key={i} className="flex flex-col gap-0.5 border-t border-rule-soft py-2 last:pb-0">
              <p>
                <Mixed text={idea.text} />
              </p>
              <p className="text-[13px] text-stone">
                <span>{T.doc.likelihood[idea.likelihood]}</span> · <span>{T.doc.minutes(idea.minutes)}</span>
              </p>
              {idea.why && (
                <p className="text-[14px] leading-[20px] text-graphite">
                  <Mixed text={idea.why} />
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>
    </BotBubble>
  );
}

// An answer is a short run of messages: the warning (when there is one), the answer with its
// source attached, the suggested checks, and the "did it help" chips.
export function DocAnswer({
  item,
  kbId,
  frames,
  animate,
  delay,
  feedback = false,
  writing = false,
  resume = false,
  time,
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
  // The answer that was being written while it arrived is now whole: go on from the letter reached.
  resume?: boolean;
  time?: string;
}) {
  // The sources are shown once, under the steps: the steps themselves stay a clean list to follow.
  const sources = answerSources(item.steps);
  // The manual's own wording, for every step at once: one switch, not a link under each step.
  const [quotes, setQuotes] = useState(false);
  // The title and the steps are written as one text, letter by letter. While the answer is
  // still arriving the text grows, and the writing goes on from where it is.
  const texts = [item.title, ...item.steps.map((s) => s.text)];
  const total = texts.reduce((n, t) => n + t.length, 0);
  const [shown, setShown] = useState(() => (resume ? Math.min(total, written.n) : writing || animate ? -Math.round(delay / CHAR_MS) : total));
  const typing = shown < total;
  // The source, the drawing and the buttons come when the text has been written, not while it is.
  const settled = !writing && !typing;
  useEffect(() => {
    if (!typing) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const done = setTimeout(() => setShown(total), 0);
      return () => clearTimeout(done);
    }
    const tick = setInterval(() => setShown((n) => Math.min(total, n + 2)), 2 * CHAR_MS);
    return () => clearInterval(tick);
  }, [typing, total]);
  useEffect(() => {
    if (writing) written.n = shown;
  }, [writing, shown]);
  // How many letters of each text are written: the title first, then each step in turn.
  const from = texts.reduce<number[]>((list, t, i) => [...list, i ? list[i - 1] + texts[i - 1].length : 0], []);
  return (
    <article className="flex flex-col gap-2">
      {item.caution && <Caution topic={item.caution} />}
      <BotBubble wide time={settled ? time : undefined}>
        <div className="flex flex-col gap-2">
          <Marks marks={item.marks} frames={frames} />
          <h2 className="text-[16px] font-bold leading-[24px] tracking-[-0.01em] text-ink">
            <Typed text={item.title} shown={shown} mixed />
          </h2>
          <ol className="flex flex-col gap-3">
            {item.steps.map((step, i) => {
              const marked = item.marks.flatMap((m, n) => (m.step === i ? [n + 1] : []));
              // A step appears when its first letter is written, not as an empty number before it.
              if (typing && shown <= from[i + 1]) return null;
              return (
                <li key={i} className="flex gap-2.5">
                  {item.steps.length > 1 && (
                    <span aria-hidden className="min-w-4 shrink-0 font-mono text-[14px] font-medium leading-[25px] text-primary">
                      {i + 1}
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p>
                      <Typed text={step.text} shown={shown - from[i + 1]} mixed />
                      {marked.map((n) => (
                        <span key={n} aria-hidden className="ms-1.5 inline-grid h-5 w-5 translate-y-[-1px] place-items-center rounded-full bg-signal font-mono text-[13px] font-medium text-night">
                          {n}
                        </span>
                      ))}
                    </p>
                    {quotes && (
                      <blockquote dir="auto" lang={isHebrew(step.quote) ? "he" : "en"} className="rounded-lg bg-mist px-3 py-2 text-[15px] leading-[23px] text-graphite">
                        {step.quote}
                        {/* Which page this line is from, when the answer leans on more than one. */}
                        {(sources.length > 1 || sources[0].pages.length > 1) && (
                          <span dir="rtl" lang="he" className="block pt-1 text-[13px] text-stone">
                            {step.source.unit === "page" ? T.doc.page : T.doc.part} <span className="font-mono">{step.source.n}</span>
                          </span>
                        )}
                      </blockquote>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {settled && item.figures?.map((f, i) => <Figure key={i} kbId={kbId} figure={f} />)}
          {settled && sources.map((e) => <SourceLink key={e.source.docId} kbId={kbId} source={e.source} pages={e.pages} />)}
          {settled && (
            <button onClick={() => setQuotes((q) => !q)} aria-expanded={quotes} className="flex min-h-11 items-center gap-2 self-start text-[14px] font-medium text-primary">
              <ArrowIcon className={`h-3.5 w-3.5 transition-transform ${quotes ? "-rotate-90" : "rotate-90"}`} />
              <span>{quotes ? T.doc.hideOriginal : T.doc.original}</span>
            </button>
          )}
        </div>
      </BotBubble>
      {settled && item.ideas?.length ? <Ideas ideas={item.ideas} /> : null}
      {settled && feedback && <Feedback kbId={kbId} />}
    </article>
  );
}

export function DocAsk({ item, interactive, animate, delay, onOption, time, frames }: { item: Extract<ChatItem, { kind: "doc_ask" }>; interactive: boolean; animate: boolean; delay: number; onOption?: (text: string) => void; time?: string; frames?: string[] }) {
  return (
    <div className="flex flex-col gap-2">
      {/* A picture that came with no question: the parts recognised in it, marked on it. */}
      {item.marks?.length ? <Marks marks={item.marks} frames={frames} /> : null}
      <BotBubble time={time}>
        <p className="font-medium">
          <Reveal text={item.question} animate={animate} delay={delay} mixed />
        </p>
      </BotBubble>
      {interactive && <QuickReplies actions={item.options.map((o) => ({ label: o, run: () => onOption?.(o) }))} />}
    </div>
  );
}

export function DocHazard({ topic, sources, kbId }: { topic: HazardTopic; sources: SourceView[]; kbId: string }) {
  return (
    <section role="alert" className="on-dark overflow-hidden rounded-[18px] bg-night text-white">
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

// A short message from the assistant, with suggested replies under it.
export function DocNote({ title, hint, actions = [], time }: { title: string; hint?: string; actions?: { label: string; run?: () => void }[]; time?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <BotBubble time={time}>
        <p>{title}</p>
        {hint && <p className="pt-1 text-[14px] leading-[21px] text-graphite">{hint}</p>}
      </BotBubble>
      <QuickReplies actions={actions} />
    </div>
  );
}
