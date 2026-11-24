// What the manuals did not answer. Every question that ended without a checked answer (nothing
// found, only suggestions from general knowledge, a stop on a hazard topic, an error) is a
// place where a document is missing or where search fails. Asked several times, it is the
// first thing the implementer should fix. Built from the conversation log; nothing new is stored.
import { sameQuestionKey } from "../same-question";
import type { QaRecord } from "./activity";

export const GAP_KINDS = ["not_found", "ideas", "hazard", "error"] as const;
export type Gap = { question: string; count: number; kinds: string[]; kbId: string; kbName?: string; lastAt: string };

export function gaps(records: QaRecord[], kbId?: string, limit = 30): Gap[] {
  const found = new Map<string, Gap>();
  for (const r of records) {
    if (!(GAP_KINDS as readonly string[]).includes(r.kind) || !r.question.trim()) continue;
    if (kbId && r.kbId !== kbId) continue;
    // Questions a measuring script asked are not the field's questions.
    if (r.conversationId?.startsWith("eval-")) continue;
    const key = `${r.kbId}/${sameQuestionKey(r.question)}`;
    const gap = found.get(key);
    if (!gap) found.set(key, { question: r.question.trim(), count: 1, kinds: [r.kind], kbId: r.kbId, ...(r.kbName ? { kbName: r.kbName } : {}), lastAt: r.at });
    else {
      gap.count++;
      if (!gap.kinds.includes(r.kind)) gap.kinds.push(r.kind);
      if (r.at > gap.lastAt) gap.lastAt = r.at;
    }
  }
  // The most asked first; among equals, the latest.
  return [...found.values()].sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, limit);
}
