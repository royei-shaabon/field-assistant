// Chat views of a Screen. Instruction text comes only from the KB (via Screen); fixed strings
// come from T; the technician's own words are shown as they typed them.
// No data fetching here: TechnicianApp owns state. Reveal is the only component with hooks.
"use client";

import { useEffect, useState } from "react";
import type { Progress } from "@/lib/conversation";
import type { PartialAnswer } from "@/lib/docs/ask";
import type { CandidateView, ChatItem, CheckView, MarkView, Screen, TreeView } from "@/lib/screen";
import type { StepView } from "@/lib/safety";
import { T } from "@/lib/ui-text";
import { DocAnswer, docAnswerWords, DocAsk, DocHazard, DocNote, Ideas } from "./DocChat";
import { CheckIcon, DocIcon, WarningIcon } from "./icons";

export type Media = Record<number, string[]>;

// Live-chat typing: reveals a message word by word (~40 words a second). Without `animate` the
// whole text is there at once (history, server render, reduced motion).
export const WORD_MS = 25;

// English terms inside Hebrew text ("battery cover", "29 psi (200 kPa)") are kept together and
// read left to right, so a bracket or a unit never lands on the wrong side or the next line.
const LATIN_RUN = /\(?[A-Za-z0-9][A-Za-z0-9 .,\-–\/()%"'°]*[A-Za-z0-9)%°]|[A-Za-z0-9]/g;

export function Mixed({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LATIN_RUN)) {
    let run = match[0];
    let start = match.index;
    // A bracket belongs to the run only when its partner is inside the run too.
    const count = (c: string) => run.split(c).length - 1;
    while (run.endsWith(")") && count(")") > count("(")) run = run.slice(0, -1);
    while (run.startsWith("(") && count("(") > count(")")) {
      run = run.slice(1);
      start += 1;
    }
    if (!/[A-Za-z]/.test(run)) continue; // plain numbers need no help
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <bdi key={start} dir="ltr" className={run.length <= 32 ? "whitespace-nowrap" : undefined}>
        {run}
      </bdi>,
    );
    last = start + run.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function Reveal({ text, animate = false, delay = 0, mixed = false }: { text: string; animate?: boolean; delay?: number; mixed?: boolean }) {
  const words = text.split(" ");
  const [shown, setShown] = useState(animate ? 0 : words.length);
  useEffect(() => {
    if (!animate) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const done = setTimeout(() => setShown(words.length), 0);
      return () => clearTimeout(done);
    }
    let n = 0;
    let tick: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      tick = setInterval(() => {
        n += 1;
        setShown(n);
        if (n >= words.length && tick) clearInterval(tick);
      }, WORD_MS);
    }, delay);
    return () => {
      clearTimeout(start);
      if (tick) clearInterval(tick);
    };
  }, [animate, delay, words.length]);
  const typing = shown < words.length;
  return (
    <>
      <span aria-hidden={typing || undefined}>{!typing && mixed ? <Mixed text={text} /> : words.slice(0, shown).join(" ")}</span>
      {typing && <span aria-hidden className="anim-caret ms-0.5 inline-block h-[18px] w-0.5 translate-y-[3px] bg-ink" />}
      {typing && <span className="sr-only">{text}</span>}
    </>
  );
}

export function wordCount(text: string): number {
  return text.split(" ").length;
}

function TechBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="anim-rise flex justify-end">
      <div className="max-w-[85%] rounded-[18px] rounded-es-md bg-bubble px-3.5 py-2.5 text-[17px] leading-[26px]">{children}</div>
    </div>
  );
}

function Label({ title, number, total, live = false }: { title: string; number?: number; total?: number; live?: boolean }) {
  return (
    <p className="flex items-center gap-2 text-xs text-stone">
      {live && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-signal shadow-[0_0_0_3px_var(--color-signal-soft)]" />}
      <span className="font-medium">{title}</span>
      {number !== undefined && (
        <span className="font-mono">
          <span>{number}</span>
          <span>/</span>
          <span>{total}</span>
        </span>
      )}
    </p>
  );
}

function SourceChip({ source }: { source: StepView["source"] }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 self-start rounded-lg bg-mist px-2.5 text-[12.5px] text-graphite">
      <DocIcon className="h-3.5 w-3.5" />
      <span>{source.title}</span>
      {source.page !== undefined && (
        <>
          <span>{T.chat.page}</span>
          <span className="font-mono">{source.page}</span>
        </>
      )}
    </span>
  );
}

// The numbered boxes are decoration for a screen reader: the same labels follow as a list.
export function MarkedImage({ src, marks }: { src?: string; marks: (MarkView & { n: number })[] }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-[#191b1e]">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- local data URL, not an optimisable asset
        <img src={src} alt={T.chat.markedPhoto} className="block w-full" />
      ) : (
        <div className="grid aspect-[4/3] place-items-center p-4 text-center text-sm text-white/70">{T.chat.notStored}</div>
      )}
      {marks.map((m) => (
        <span key={m.n}>
          <span
            aria-hidden
            className="absolute rounded-lg border-[3px] border-signal shadow-[0_0_0_1.5px_var(--color-ink),inset_0_0_0_1.5px_var(--color-ink)]"
            style={{ left: `${m.box.x / 10}%`, top: `${m.box.y / 10}%`, width: `${m.box.w / 10}%`, height: `${m.box.h / 10}%` }}
          />
          <span
            aria-hidden
            className="absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-signal font-mono text-[13px] font-medium text-ink shadow-[0_0_0_1.5px_var(--color-ink)]"
            style={{ left: `${m.box.x / 10}%`, top: `${m.box.y / 10}%` }}
          >
            {m.n}
          </span>
        </span>
      ))}
    </div>
  );
}

function MarkList({ marks }: { marks: MarkView[] }) {
  return (
    <ol className="flex flex-col gap-1">
      {marks.map((m, i) => (
        <li key={i} className="flex items-center gap-2 text-sm text-ink-soft">
          <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-signal font-mono text-[10px] font-medium text-ink">{i + 1}</span>
          <span>{m.label}</span>
        </li>
      ))}
    </ol>
  );
}

function MediaBubble({ item, frames }: { item: Extract<ChatItem, { kind: "media" }>; frames?: string[] }) {
  return (
    <div className="anim-rise flex flex-col items-end gap-1.5">
      <div className="w-[60%] overflow-hidden rounded-2xl rounded-es-md bg-[#191b1e]">
        {frames?.[0] ? (
          // eslint-disable-next-line @next/next/no-img-element -- local data URL
          <img src={frames[0]} alt={T.chat.sentPhoto} className="block w-full" />
        ) : (
          <div className="grid aspect-[4/3] place-items-center p-3 text-center text-xs text-white/70">{T.chat.notStored}</div>
        )}
      </div>
      {item.media === "video" && (
        <p className="flex gap-1 text-xs text-stone">
          <span>{T.chat.video}</span>
          <span>·</span>
          <span className="font-mono">{item.frames}</span>
          <span>{T.chat.frames}</span>
        </p>
      )}
      {item.said && <div className="max-w-[80%] rounded-[18px] rounded-es-md bg-bubble px-3.5 py-2.5 text-[17px] leading-[26px]">{item.said}</div>}
    </div>
  );
}

export function StopCard({ danger = false, onAck }: { danger?: boolean; onAck?: () => void }) {
  return (
    <section role="alert" className="on-dark overflow-hidden rounded-[18px] bg-ink text-white">
      <div className="hazard-stripe h-2.5" />
      <div className="flex flex-col gap-2.5 px-[18px] pb-5 pt-[18px]">
        <div className="flex items-center gap-2.5">
          <WarningIcon className="h-[26px] w-[26px] text-signal" />
          <p className="text-2xl font-semibold leading-[30px]">{danger ? T.stop.dangerTitle : T.stop.title}</p>
        </div>
        <p className="text-[17px] leading-[26px]">{danger ? T.stop.danger : T.stop.hazard}</p>
        {!danger && <p className="text-sm leading-[21px] text-[#c9c9c4]">{T.stop.hazardNote}</p>}
        {onAck && (
          <button onClick={onAck} className="mt-2 h-12 rounded-[14px] bg-white text-base font-medium text-ink active:opacity-90">
            {T.stop.acknowledge}
          </button>
        )}
      </div>
    </section>
  );
}

type Handlers = {
  onPick?: (symptomId: string) => void;
  onOther?: () => void;
  onAck?: (symptomId: string) => void;
  // Document knowledge bases: which one (for source links) and a tap on a suggested reply.
  kbId?: string;
  onOption?: (text: string) => void;
  // "Add a photo" under a not-found reply.
  onAttach?: () => void;
};

function NeedMore({ item, interactive, onPick, onOther }: { item: Extract<ChatItem, { kind: "need_more" }>; interactive: boolean } & Handlers) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base leading-[25px]">{T.chat.needMore}</p>
      <div className="flex items-center gap-3.5 rounded-2xl border border-rule p-3.5">
        <div aria-hidden className="relative h-16 w-[84px] shrink-0 rounded-[10px] bg-mist">
          <span className="absolute right-2 top-2 h-3 w-3 rounded-tr-[3px] border-r-[2.5px] border-t-[2.5px] border-ink" />
          <span className="absolute left-2 top-2 h-3 w-3 rounded-tl-[3px] border-l-[2.5px] border-t-[2.5px] border-ink" />
          <span className="absolute bottom-2 right-2 h-3 w-3 rounded-br-[3px] border-b-[2.5px] border-r-[2.5px] border-ink" />
          <span className="absolute bottom-2 left-2 h-3 w-3 rounded-bl-[3px] border-b-[2.5px] border-l-[2.5px] border-ink" />
          <span className="absolute left-[30px] top-[26px] h-3 w-6 rounded-[3px] bg-signal" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[15px] font-semibold">{T.chat.retakeTitle}</p>
          <ul className="list-disc pe-0 ps-4 text-sm leading-[21px] text-ink-soft">
            {T.chat.retake.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mt-1 text-base leading-[25px]">{T.chat.orPick}</p>
      <div role="group" aria-label={T.chat.orPick} className="flex flex-col gap-1.5">
        {item.options.map((o) => (
          <button
            key={o.symptomId}
            disabled={!interactive}
            onClick={() => onPick?.(o.symptomId)}
            className="flex min-h-12 items-center gap-3 rounded-[14px] border border-rule bg-paper px-3.5 text-start text-base active:bg-mist disabled:opacity-60"
          >
            <span aria-hidden className="h-[18px] w-[18px] shrink-0 rounded-full border-2 border-[#b4b4ae]" />
            <span>{o.title}</span>
          </button>
        ))}
        <button
          disabled={!interactive}
          onClick={onOther}
          className="flex min-h-12 items-center gap-3 rounded-[14px] border border-rule bg-paper px-3.5 text-start text-base text-graphite active:bg-mist disabled:opacity-60"
        >
          <span aria-hidden className="h-[18px] w-[18px] shrink-0 rounded-full border-2 border-dashed border-[#b4b4ae]" />
          <span>{T.chat.other}</span>
        </button>
      </div>
    </div>
  );
}

function Done({ candidates }: { candidates: CandidateView[] }) {
  const solved = candidates.some((c) => c.status === "resolved");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base leading-[25px]">{solved ? T.chat.doneSome : T.chat.doneNone}</p>
      <ul className="flex flex-col">
        {candidates.map((c) => (
          <li key={c.symptomId} className="flex items-center gap-3 border-b border-rule-soft py-2.5 last:border-0">
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${c.status === "resolved" ? "bg-ok" : c.status === "stopped" ? "bg-danger" : "bg-pebble"}`}
            />
            <span className="flex-1">{c.title}</span>
            <span className="text-sm text-stone">{T.status[c.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One chat item. `animate` types a bot message out; `delay` staggers several new ones.
function Item({
  item,
  screen,
  media,
  interactive,
  animate,
  fresh = false,
  delay,
  ...handlers
}: {
  item: ChatItem;
  screen: Screen;
  media: Media;
  interactive: boolean;
  animate: boolean;
  // Arrived in this exchange (as opposed to a reopened conversation).
  fresh?: boolean;
  delay: number;
} & Handlers) {
  const say = (text: string) => (
    <p className="text-base leading-[25px]">
      <Reveal text={text} animate={animate} delay={delay} />
    </p>
  );
  switch (item.kind) {
    case "text":
      return <TechBubble>{item.said}</TechBubble>;
    case "media":
      return <MediaBubble item={item} frames={media[item.eventIndex]} />;
    case "picked":
      return (
        <TechBubble>
          <span className="text-graphite">{T.chat.picked}</span> <span>{item.symptomTitle}</span>
        </TechBubble>
      );
    case "answer":
      return <TechBubble>{item.said ?? T.answer[item.outcome]}</TechBubble>;
    case "acknowledged":
      return <TechBubble>{T.stop.acknowledged}</TechBubble>;
    case "marked": {
      const numbered = item.marks.map((m, i) => ({ ...m, n: i + 1 }));
      const frames = [...new Set(item.marks.map((m) => m.frame))].sort((a, b) => a - b);
      return (
        <figure className="anim-rise m-0 flex flex-col gap-2">
          <p className="text-base leading-[25px]">{T.chat.marked}</p>
          {frames.map((f) => (
            <MarkedImage key={f} src={media[item.eventIndex]?.[f]} marks={numbered.filter((m) => m.frame === f)} />
          ))}
          <figcaption>
            <MarkList marks={item.marks} />
          </figcaption>
        </figure>
      );
    }
    case "need_more":
      return <NeedMore item={item} interactive={interactive} {...handlers} />;
    case "candidates":
      return (
        <div className="flex flex-col gap-2">
          {say(item.list.length > 1 ? T.chat.candidatesMany : T.chat.candidatesOne)}
          <ol className="anim-rise flex flex-col gap-1">
            {item.list.map((c, i) => (
              <li key={c.symptomId} className="flex items-baseline gap-2.5">
                <span className="font-mono text-sm text-stone">{i + 1}</span>
                <span className="font-medium">{c.title}</span>
                <span className="text-xs text-stone">{T.chat.confidence[c.confidence]}</span>
              </li>
            ))}
          </ol>
        </div>
      );
    case "asked":
      return (
        <div className="flex flex-col gap-1">
          <Label title={item.symptomTitle} number={item.number} total={item.total} />
          <p className="text-base font-medium leading-6 text-ink-soft">{item.check}</p>
        </div>
      );
    case "repeat":
      return say(T.chat.repeat);
    case "track_resolved":
      return (
        <div className="flex gap-2.5">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok text-white">
            <CheckIcon className="h-3 w-3" />
          </span>
          <div className="flex flex-col gap-0.5">
            <Label title={item.symptomTitle} />
            <p className="text-base leading-[25px]">
              <span className="font-semibold">{T.chat.resolved}</span> <Reveal text={item.resolution} animate={animate} delay={delay} />
            </p>
          </div>
        </div>
      );
    case "track_closed":
      return (
        <div className="flex flex-col gap-0.5">
          <Label title={item.symptomTitle} />
          <p className="text-base leading-[25px]">
            <span className="font-semibold">{T.chat.closed}</span>{" "}
            <Reveal text={item.reason === "tree" && item.detail ? item.detail : item.reason === "step_limit" ? T.chat.stepLimit : T.chat.unclear} animate={animate} delay={delay} />
          </p>
        </div>
      );
    case "track_stopped":
      return <StopCard onAck={interactive && screen.pendingStop && handlers.onAck ? () => handlers.onAck!(screen.pendingStop!.symptomId) : undefined} />;
    case "continue":
      return (
        <p className="text-base leading-[25px]">
          <span>{T.chat.continue}</span> <span className="font-medium">{item.symptomTitle}</span>
        </p>
      );
    case "stopped":
      return item.reason === "danger" ? <StopCard danger /> : say(T.ended[item.reason]);
    case "done":
      return (
        <div className="flex flex-col gap-2">
          <Done candidates={screen.candidates} />
          <p className="text-sm text-stone">{T.chat.newHint}</p>
        </div>
      );
    case "doc_answer":
      return <DocAnswer item={item} kbId={handlers.kbId ?? ""} frames={media[item.eventIndex]} animate={animate} delay={delay} feedback={fresh} />;
    case "doc_ask":
      return <DocAsk item={item} interactive={interactive} animate={animate} delay={delay} onOption={handlers.onOption} />;
    case "doc_hazard":
      return <DocHazard topic={item.topic} sources={item.sources} kbId={handlers.kbId ?? ""} />;
    case "doc_ideas":
      return (
        <div className="flex flex-col gap-3">
          <DocNote title={T.doc.ideasNotFound} />
          <Ideas ideas={item.ideas} />
          <DocNote title="" actions={interactive ? [{ label: T.doc.rephrase, run: handlers.onOther }, { label: T.doc.addPhoto, run: handlers.onAttach }] : []} />
        </div>
      );
    case "doc_not_found":
      return <DocNote title={T.doc.notFound} hint={T.doc.notFoundHint} actions={interactive ? [{ label: T.doc.rephrase, run: handlers.onOther }, { label: T.doc.addPhoto, run: handlers.onAttach }] : []} />;
    case "doc_error":
      return <DocNote title={T.doc.error} />;
    case "doc_empty":
      return <DocNote title={T.doc.empty} />;
  }
}

export type ProgressStep = { key: Progress; done: boolean; detail?: string };

export function ProgressLines({ steps }: { steps: ProgressStep[] }) {
  if (!steps.length) return null;
  return (
    <ol className="flex flex-col gap-2.5 text-[15px]">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-2.5">
          {s.done ? (
            <CheckIcon className="h-4 w-4 text-ink" />
          ) : (
            <svg aria-hidden className="anim-spin h-4 w-4" viewBox="0 0 24 24" fill="none" strokeWidth="2.5">
              <circle cx="12" cy="12" r="9" stroke="var(--color-rule-soft)" />
              <path d="M12 3a9 9 0 0 1 9 9" stroke="var(--color-ink)" strokeLinecap="round" />
            </svg>
          )}
          <span className={s.done ? "text-ink-soft" : "anim-shimmer font-medium"}>{T.progress[s.key]}</span>
        </li>
      ))}
    </ol>
  );
}

// The open question, last in the chat. Its answer buttons live in the bar under the chat.
export function CurrentQuestion({ check, animate, delay }: { check: CheckView; animate: boolean; delay: number }) {
  const { view } = check;
  return (
    <section aria-label={check.title} className="flex flex-col gap-2.5">
      <Label title={check.title} number={check.number} total={check.total} live />
      <p className="text-[19px] font-semibold leading-[27px]">
        <Reveal text={view.check} animate={animate} delay={delay} />
      </p>
      {view.how && (
        <div className="text-[15px] leading-[23px] text-ink-soft">
          <p className="text-xs font-medium text-stone">{T.chat.how}</p>
          <p>{view.how}</p>
        </div>
      )}
      {view.conflict && <p className="text-sm text-graphite">{T.chat.conflict}</p>}
      {view.tip && (
        <div className="flex flex-col gap-0.5 rounded-xl bg-mist px-3 py-2.5 text-sm">
          <p className="font-medium">
            <span>{T.chat.tipBy}</span> <span>{view.tip.author}</span>
          </p>
          <p className="text-ink-soft">{view.tip.text}</p>
        </div>
      )}
      <SourceChip source={view.source} />
    </section>
  );
}

// The fault map, sent as a chat message on request. Built from the KB trees and the answers.
export function MapCard({ trees, candidates, from }: { trees: TreeView[]; candidates: CandidateView[]; from: "photo" | "video" | "text" }) {
  if (!trees.length) return <p className="text-base leading-[25px]">{T.map.empty}</p>;
  const line = <div aria-hidden className="h-2.5 w-0.5 self-center bg-[#d6d6d1]" />;
  return (
    <figure aria-label={T.map.title} className="m-0 flex flex-col rounded-2xl border border-rule px-3 pb-3 pt-3.5">
      <div className="flex items-center gap-1.5 self-center rounded-[10px] bg-ink px-3 py-1.5 text-[13px] text-white">
        <span>{T.map.from}</span>
        <span>·</span>
        <span>{T.map[from]}</span>
      </div>
      {line}
      {trees.length > 1 && <div aria-hidden className="mx-[18%] h-0.5 bg-[#d6d6d1]" />}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.min(trees.length, 3)}, minmax(0, 1fr))` }}>
        {trees.map((tree) => {
          const c = candidates.find((x) => x.symptomId === tree.symptomId)!;
          const visited = tree.nodes.filter((n) => n.state !== "todo");
          const todo = tree.nodes.filter((n) => n.state === "todo" && !n.hazard).length;
          return (
            <div key={tree.symptomId} className="flex min-w-0 flex-col">
              {line}
              <div className="rounded-[10px] bg-mist px-2.5 py-2">
                <p className="text-[13px] font-semibold leading-tight">{tree.title}</p>
                <p className="text-[11px] text-stone">{T.status[c.status]}</p>
              </div>
              {visited.map((n) => (
                <div key={n.stepId} className="flex flex-col">
                  {line}
                  {n.state === "stopped" ? (
                    <div className="flex items-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-danger px-2 py-1.5 text-danger-ink">
                      <WarningIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="text-xs font-medium">{T.map.hazard}</span>
                    </div>
                  ) : n.state === "current" ? (
                    <div className="flex items-start gap-1.5 rounded-[10px] border-2 border-ink px-2 py-1.5 shadow-[0_0_0_3px_var(--color-signal-soft)]">
                      <span aria-hidden className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 border-ink">
                        <span className="h-1.5 w-1.5 rounded-full bg-signal" />
                      </span>
                      <span className="text-xs font-medium leading-4">{n.check}</span>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 rounded-[10px] border border-rule px-2 py-1.5">
                      <span aria-hidden className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ink text-white">
                        <CheckIcon className="h-2.5 w-2.5" />
                      </span>
                      <span className="text-xs leading-4">
                        <span>{n.check}</span> <b className="font-semibold">{n.answer === "fail" ? T.answer.fail : T.answer.pass}</b>
                      </span>
                    </div>
                  )}
                </div>
              ))}
              {todo > 0 && c.status === "open" && (
                <div className="flex flex-col">
                  {line}
                  <div className="flex items-center gap-1.5 rounded-[10px] border border-dashed border-[#d6d6d1] px-2 py-1.5 text-stone">
                    <span aria-hidden className="h-4 w-4 shrink-0 rounded-full border-2 border-[#d6d6d1]" />
                    <span className="flex gap-1 text-xs">
                      <span>{T.map.more}</span>
                      <span className="font-mono">{todo}</span>
                      <span>{T.map.checks}</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 border-t border-rule-soft pt-2.5 text-xs text-stone">{T.map.footer}</p>
    </figure>
  );
}

export type ChatProps = {
  screen: Screen;
  media: Media;
  // Items from this index on are new: their text types out, one after another.
  animateFrom?: number;
  // Fault maps the technician asked for, each shown after this many chat items.
  maps?: number[];
  mapFrom?: "photo" | "video" | "text";
  progress?: ProgressStep[];
  // The newest answer already appeared step by step: show it complete, without typing it out.
  streamed?: boolean;
  // An answer that is still being written.
  live?: PartialAnswer | null;
  // What the technician just sent, shown before the server answers.
  pending?: React.ReactNode;
} & Handlers;

// The whole conversation, in reading order. Returns the typing time of new messages so the
// caller can hold the answer buttons until the question is complete.
export function chatTypingMs(screen: Screen, animateFrom: number): number {
  let words = 0;
  screen.items.slice(animateFrom).forEach((item) => {
    if (item.kind === "candidates") words += wordCount(item.list.length > 1 ? T.chat.candidatesMany : T.chat.candidatesOne);
    if (item.kind === "repeat") words += wordCount(T.chat.repeat);
    if (item.kind === "track_resolved") words += wordCount(item.resolution);
    if (item.kind === "track_closed") words += wordCount(item.detail ?? T.chat.unclear);
    if (item.kind === "stopped" && item.reason !== "danger") words += wordCount(T.ended[item.reason]);
    if (item.kind === "doc_answer") words += docAnswerWords(item);
    if (item.kind === "doc_ask") words += wordCount(item.question);
  });
  if (screen.current && animateFrom <= screen.items.length) words += wordCount(screen.current.view.check);
  return words * WORD_MS;
}

export function ChatView({ screen, media, animateFrom = Number.MAX_SAFE_INTEGER, maps = [], mapFrom = "text", progress = [], streamed = false, live = null, pending, ...handlers }: ChatProps) {
  let delay = 0;
  const kinds = screen.items.map((i) => i.kind);
  const lastNeedMore = kinds.lastIndexOf("need_more");
  const lastStop = kinds.lastIndexOf("track_stopped");
  const lastAsk = kinds.length - 1; // a clarifying question takes taps only while it is the last message
  const nodes: React.ReactNode[] = [];
  const pushMaps = (count: number) =>
    maps
      .filter((m) => m === count)
      .forEach((_, i) =>
        nodes.push(
          <TechBubble key={`ask-${count}-${i}`}>{T.chat.mapAsk}</TechBubble>,
          <div key={`map-${count}-${i}`} className="flex flex-col gap-2">
            <p className="text-base leading-[25px]">{T.chat.mapIntro}</p>
            <MapCard trees={screen.trees} candidates={screen.candidates} from={mapFrom} />
          </div>,
        ),
      );

  pushMaps(0);
  screen.items.forEach((item, i) => {
    const animate = i >= animateFrom;
    nodes.push(
      <Item
        key={i}
        item={item}
        screen={screen}
        media={media}
        interactive={(screen.mode === "identify" && i === lastNeedMore) || (screen.mode === "stop" && i === lastStop) || ((item.kind === "doc_ask" || item.kind === "doc_not_found" || item.kind === "doc_ideas") && i === lastAsk && !progress.length && !pending)}
        animate={animate && !(streamed && item.kind === "doc_answer")}
        fresh={animate}
        delay={delay}
        {...handlers}
      />,
    );
    if (animate && item.kind === "candidates") delay += wordCount(item.list.length > 1 ? T.chat.candidatesMany : T.chat.candidatesOne) * WORD_MS;
    if (animate && (item.kind === "track_resolved" || item.kind === "track_closed")) delay += wordCount(item.kind === "track_resolved" ? item.resolution : (item.detail ?? T.chat.unclear)) * WORD_MS;
    if (animate && item.kind === "repeat") delay += wordCount(T.chat.repeat) * WORD_MS;
    if (animate && item.kind === "doc_answer") delay += docAnswerWords(item) * WORD_MS;
    if (animate && item.kind === "doc_ask") delay += wordCount(item.question) * WORD_MS;
    pushMaps(i + 1);
  });

  return (
    <div className="flex flex-col gap-[22px]">
      {/* A log: a screen reader announces each new message as it arrives. */}
      <div role="log" aria-live="polite" aria-relevant="additions" className="flex flex-col gap-[22px]">
        {nodes}
        {pending}
        {live && <DocAnswer item={{ by: "bot", kind: "doc_answer", eventIndex: -1, marks: [], ...live }} kbId={handlers.kbId ?? ""} animate={false} delay={0} writing />}
      </div>
      {/* Always mounted, so progress is announced when its text changes. */}
      <div role="status">
        <ProgressLines steps={progress} />
      </div>
      {screen.current && !progress.length && (
        <CurrentQuestion check={screen.current} animate={animateFrom <= screen.items.length} delay={delay} />
      )}
    </div>
  );
}
