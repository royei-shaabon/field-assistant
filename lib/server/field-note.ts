// A report from a technician's phone: what solved a fault, in their own words. It is shown to
// other technicians at once, marked as not yet checked, unless it touches a hazard topic
// (brakes, fuel, hot coolant, a running engine): then it waits for the implementer's approval
// like any other note. The meaning index of the reports is brought up to date on the spot, so
// the report is found by what it means and not only by its words.
import { hazardTopic } from "@/lib/docs/ask";
import { embedder } from "@/lib/docs/embed";
import { indexDoc } from "@/lib/docs/semantic";
import { log } from "@/lib/server/log";
import { FIELD_DOC, type KbStore, type NoteFrom } from "@/lib/store";

export const touchesHazard = (text: string) => hazardTopic(text, { hazard: "none", steps: [{ text: "", ref: "", quote: text }] }) !== null;

export async function addFieldNote(store: KbStore, env: string, kbId: string, text: string, from: NoteFrom, by?: string): Promise<{ shown: boolean }> {
  const note = await store.addNote(kbId, { text, from, hold: touchesHazard(text), ...(by ? { by } : {}) });
  const shown = note.f !== undefined && !note.held && note.status === "pending";
  log.info("note.added", { env, kb: kbId, from, chars: note.text.length, shown });
  const using = embedder();
  if (shown && using) await indexDoc(store, using, kbId, FIELD_DOC, 8000).catch(() => {});
  return { shown };
}
