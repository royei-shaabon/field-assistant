// Writes down what happened to a question: the record the implementer reads, the day's
// numbers the dashboard draws, and a log line. A failure here never fails the answer.
import type { DocEvent } from "../docs/conversation";
import type { AskTiming } from "../docs/ask";
import { activity } from "../store";
import { bump, SLOW_MS, type Channel } from "../store/activity";
import { log } from "./log";

export const channelOf = (value: unknown): Channel => (value === "voice" || value === "video" ? value : "chat");

export async function recordTurn(envId: string, kb: { id: string; name: string }, event: DocEvent, meta: { conversationId?: string; channel: Channel }, timing?: AskTiming): Promise<void> {
  const r = event.result;
  const source = (s: { docName: string; unit: string; n: number }) => `${s.docName} · ${s.n}`;
  try {
    const book = activity(envId);
    await book.record({
      kbId: kb.id,
      kbName: kb.name,
      conversationId: meta.conversationId,
      channel: meta.channel,
      // A question with a picture and no words is noted as such.
      question: event.said ?? (event.media ? `[${event.media}]` : ""),
      kind: r.kind,
      ...(r.kind === "answer" ? { title: r.title, steps: r.steps.map((s) => s.text), sources: [...new Set(r.steps.map((s) => source(s.source)))] } : {}),
      ...(r.kind === "ask" ? { title: r.question } : {}),
      ...((r.kind === "answer" || r.kind === "ideas") && r.ideas?.length ? { ideas: r.ideas.map((i) => i.text) } : {}),
      ...(r.kind === "hazard" ? { sources: r.sources.map(source) } : {}),
      ms: timing?.total,
      firstStepMs: timing?.firstStep ?? undefined,
    });
    await book.measure((day) => {
      day.questions++;
      bump(day.byKind, r.kind);
      bump(day.byChannel, meta.channel);
      if (r.kind === "error") day.errors++;
      if (timing) {
        day.timed++;
        day.totalMs += timing.total;
        day.firstStepMs += timing.firstStep ?? timing.total;
        if (timing.total > SLOW_MS) day.slow++;
      }
    });
  } catch (e) {
    log.error("record.failed", e, { env: envId, kb: kb.id });
  }
}
