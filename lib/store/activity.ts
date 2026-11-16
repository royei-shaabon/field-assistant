// What happened in an environment: every question and its answer (text only: no pictures, no
// sound), and the day's numbers. This is what the implementer's "conversations" page and the
// dashboard read. Kept per environment:
//   log/<yyyy-mm-dd>/<time>-<id>.json   one question and its answer
//   log/removed/<conversationId>.json   the technician removed that conversation from their list
//   metrics/<yyyy-mm-dd>.json           the day's counters and timings
import { randomBytes } from "node:crypto";
import type { BlobDriver } from "./types";

export type Channel = "chat" | "voice" | "video";

export type QaRecord = {
  id: string;
  at: string;
  kbId: string;
  kbName?: string;
  // The conversation on the technician's phone this belongs to.
  conversationId?: string;
  channel: Channel;
  question: string;
  // How it ended: answer, ask, not_found, ideas, hazard, error, or "voice" for a spoken answer
  // (the live model spoke from the passages; the checked answer is a separate record).
  kind: string;
  title?: string;
  steps?: string[];
  ideas?: string[];
  sources?: string[];
  ms?: number;
  firstStepMs?: number;
  // kind "survey": what the technician answered after a call.
  survey?: { solved?: string; improve?: string; again?: string };
  // Filled when read: the technician removed the conversation from their list (soft delete).
  removedAt?: string;
};

export type DayMetrics = {
  date: string;
  questions: number;
  byKind: Record<string, number>;
  byChannel: Record<string, number>;
  // Checked answers: how long they took, and how many took longer than 15 seconds.
  timed: number;
  totalMs: number;
  firstStepMs: number;
  slow: number;
  // The live call's fast search.
  lookups: number;
  lookupMs: number;
  calls: number;
  errors: number;
  helpful: number;
  unhelpful: number;
  // The short survey after a call: was the problem solved, and what should be better.
  surveys?: number;
  solved?: Record<string, number>;
  improve?: Record<string, number>;
  // Careful looks at a picture in a video call.
  looks?: number;
  lookMs?: number;
};

export const emptyDay = (date: string): DayMetrics => ({ date, questions: 0, byKind: {}, byChannel: {}, timed: 0, totalMs: 0, firstStepMs: 0, slow: 0, lookups: 0, lookupMs: 0, calls: 0, errors: 0, helpful: 0, unhelpful: 0 });

export const SLOW_MS = 15_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONVERSATION = /^[a-z0-9-]{4,40}$/;
const clip = (text: unknown, max: number) => (typeof text === "string" ? text.slice(0, max) : "");

export const dayOf = (at: Date) => at.toISOString().slice(0, 10);

export function lastDays(n: number, now = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => dayOf(new Date(now.getTime() - (n - 1 - i) * 86_400_000)));
}

// One writer at a time per file: the service runs as a single instance, so this is enough to
// keep two answers that finish together from losing a count.
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(key, next.catch(() => {}));
  return next;
}

export class Activity {
  constructor(
    private driver: BlobDriver,
    // Names the queue: two environments never wait for each other.
    private scope = "",
  ) {}

  async record(entry: Omit<QaRecord, "id" | "at" | "removedAt">, now = new Date()): Promise<QaRecord> {
    const record: QaRecord = {
      ...entry,
      id: `${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`,
      at: now.toISOString(),
      question: clip(entry.question, 600),
      title: entry.title && clip(entry.title, 200),
      steps: entry.steps?.slice(0, 12).map((s) => clip(s, 500)),
      ideas: entry.ideas?.slice(0, 6).map((s) => clip(s, 300)),
      sources: entry.sources?.slice(0, 6).map((s) => clip(s, 120)),
      conversationId: entry.conversationId && CONVERSATION.test(entry.conversationId) ? entry.conversationId : undefined,
    };
    await this.driver.write(`log/${dayOf(now)}/${String(now.getTime()).padStart(14, "0")}-${record.id}.json`, Buffer.from(JSON.stringify(record)));
    return record;
  }

  // Soft delete: the conversation stays in the log, marked as removed by the technician.
  async markRemoved(conversationId: string, now = new Date()): Promise<boolean> {
    if (!CONVERSATION.test(conversationId)) return false;
    await this.driver.write(`log/removed/${conversationId}.json`, Buffer.from(JSON.stringify({ at: now.toISOString() })));
    return true;
  }

  // The newest records first, from the given days (newest day first).
  async recent(days: string[], limit = 100): Promise<QaRecord[]> {
    const out: QaRecord[] = [];
    const removed = new Map<string, string>();
    for (const key of await this.driver.list("log/removed")) {
      try {
        removed.set(key.split("/").at(-1)!.replace(/\.json$/, ""), JSON.parse((await this.driver.read(key))!.toString("utf8")).at);
      } catch {
        // A damaged marker is ignored.
      }
    }
    for (const day of [...days].reverse()) {
      if (!DAY.test(day) || out.length >= limit) continue;
      const keys = (await this.driver.list(`log/${day}`)).sort().reverse();
      for (const key of keys.slice(0, limit - out.length)) {
        try {
          const record = JSON.parse((await this.driver.read(key))!.toString("utf8")) as QaRecord;
          const gone = record.conversationId && removed.get(record.conversationId);
          out.push(gone ? { ...record, removedAt: gone } : record);
        } catch {
          // A damaged record is skipped.
        }
      }
    }
    return out;
  }

  async day(date: string): Promise<DayMetrics> {
    if (!DAY.test(date)) return emptyDay(date);
    try {
      return { ...emptyDay(date), ...JSON.parse((await this.driver.read(`metrics/${date}.json`))!.toString("utf8")) };
    } catch {
      return emptyDay(date);
    }
  }

  days(dates: string[]): Promise<DayMetrics[]> {
    return Promise.all(dates.map((d) => this.day(d)));
  }

  // Changes today's numbers. `change` gets the day and edits it in place.
  measure(change: (day: DayMetrics) => void, now = new Date()): Promise<void> {
    const date = dayOf(now);
    return inTurn(`${this.scope}/${date}`, async () => {
      const day = await this.day(date);
      change(day);
      await this.driver.write(`metrics/${date}.json`, Buffer.from(JSON.stringify(day)));
    });
  }
}

export const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};
