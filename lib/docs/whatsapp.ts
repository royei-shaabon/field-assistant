// A chat exported from a WhatsApp group of technicians: most faults are solved there, and what
// was learned stays in the chat. This reads the export, removes who said what (names and phone
// numbers are replaced before anything is stored or sent to a model, and the file itself is
// never kept), and asks the main model to pick out faults with the fixes that the chat itself
// shows. Each one becomes a note that waits for the implementer's approval.
import fs from "node:fs";
import path from "node:path";
import type { ModelClient } from "../llm";

// `picture`: the name of a picture file sent with the message, when the export names one.
export type ChatMessage = { by: string; text: string; picture?: string };
// A picture from the exported chat, made small by the implementer's browser. It is shown to the
// model so it understands what was said about it, and is never stored.
export type ChatPicture = { data: string; mediaType: "image/jpeg" };
export const MAX_PICTURES = 30;
const PICTURES_PER_WINDOW = 5;
// "<attached: NAME>" (iPhone) or "NAME (file attached)" (Android), for a picture file.
const ATTACHED = /<attached:\s*([^>]{1,120}\.(?:jpe?g|png|webp))>|(\S{1,120}\.(?:jpe?g|png|webp))\s*\((?:file attached|קובץ מצורף)\)/i;
export const pictureNamesIn = (raw: string): string[] => [...new Set([...raw.matchAll(new RegExp(ATTACHED.source, "gi"))].map((m) => (m[1] ?? m[2]).trim()))];

export const MAX_CHAT_BYTES = 2_000_000;
const WINDOW_CHARS = 9000;
const MAX_WINDOWS = 14;

// "[12/03/2024, 10:15:22] Name: text" (iPhone) or "12/03/2024, 10:15 - Name: text" (Android).
const LINE = /^‎?\[?(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[AP]M)?\]?\s*(?:-\s*)?([^:]{1,60}?):\s(.*)$/i;
const NO_TEXT = /^‎?(<[^>]*omitted>|.*\b(image|video|audio|sticker|GIF|document) omitted|<המדיה לא נכללה>|.*(תמונה|סרטון|שמע|מדבקה|מסמך) (הושמט|הושמטה).*|This message was deleted|הודעה זו נמחקה|null)$/i;

// The messages of an exported chat, in order. Lines that are not a message (who joined, the
// encryption notice) are dropped; a line with no date continues the message before it.
export function parseChat(raw: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const m = LINE.exec(line);
    if (m) {
      const attached = ATTACHED.exec(m[3]);
      const text = m[3].replace(ATTACHED, "").replace(/\u200e/g, "").trim();
      const picture = attached ? (attached[1] ?? attached[2]).trim() : undefined;
      if (text && !NO_TEXT.test(text)) out.push({ by: m[2].trim(), text, ...(picture ? { picture } : {}) });
      else out.push({ by: m[2].trim(), text: "", ...(picture ? { picture } : {}) });
    } else if (out.length && line.trim() && !/^‎?\[?\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(line)) {
      out[out.length - 1].text += `\n${line.trim()}`;
    }
  }
  // A message that is only a picture is kept: the picture may be what the next message is about.
  return out.filter((m) => m.text.trim() || m.picture);
}

// Seven digits and up: a local number with no area code is still a phone number.
const PHONE = /\+?\d[\d\s\-()]{5,}\d/g;
// Bounded on both sides, so a long run of letters with no "@" costs nothing.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// More senders than any real group: the file is not a chat, or was made to keep the server busy.
export const MAX_SENDERS = 300;
const MAX_MESSAGE = 1500;

export class NotAChat extends Error {}

// Every sender becomes "טכנאי N", and their names, phone numbers and e-mail addresses inside
// the messages are replaced too. A name is known only from who wrote in the chat: a person who
// is only mentioned, and never wrote, is not recognised.
export function withoutPeople(messages: ChatMessage[]): ChatMessage[] {
  const alias = new Map<string, string>();
  for (const m of messages) {
    if (!alias.has(m.by)) alias.set(m.by, `טכנאי ${alias.size + 1}`);
    if (alias.size > MAX_SENDERS) throw new NotAChat("too many senders");
  }
  // A sender's full name and each word of it (two letters or more), longest first, as one pattern
  // that is built once: every message is then cleaned in a single pass.
  const byWord = new Map<string, string>();
  for (const [name, a] of alias) for (const w of [name, ...name.split(/\s+/)]) if (w.replace(/[\d\s+\-()]/g, "").length >= 2 && !byWord.has(w.toLowerCase())) byWord.set(w.toLowerCase(), a);
  const words = [...byWord.keys()].sort((x, y) => y.length - x.length);
  const names = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  const scrub = (text: string) => {
    // Cut first: nothing below ever runs over more than one bounded message.
    const t = text.slice(0, MAX_MESSAGE).replace(EMAIL, "[כתובת]").replace(/@\u2068?[^\s\u2069]{2,40}\u2069?/g, "[טכנאי]").replace(PHONE, "[מספר]");
    return names ? t.replace(names, (w) => byWord.get(w.toLowerCase()) ?? "[טכנאי]") : t;
  };
  return messages.map((m) => ({ by: alias.get(m.by)!, text: scrub(m.text), ...(m.picture ? { picture: m.picture } : {}) }));
}

// The chat in pieces a model can read at once, the newest pieces first (bounded).
export type ChatWindow = { text: string; pictures: { n: number; picture: ChatPicture }[] };

// The chat in pieces a model can read at once, the newest pieces first (bounded). A message
// whose picture was sent along is marked "[picture N]", and the picture goes with the piece.
export function chatWindows(messages: ChatMessage[], pictures: Map<string, ChatPicture> = new Map()): ChatWindow[] {
  const windows: ChatWindow[] = [];
  let current: ChatWindow = { text: "", pictures: [] };
  let n = 0;
  for (const m of messages) {
    const shown = m.picture ? pictures.get(m.picture) : undefined;
    const mark = shown && current.pictures.length < PICTURES_PER_WINDOW ? ` [picture ${++n}]` : m.picture ? " [a picture, not shown]" : "";
    const line = `${m.by}: ${m.text}${mark}\n`;
    if (current.text.length + line.length > WINDOW_CHARS && current.text) {
      windows.push(current);
      current = { text: "", pictures: [] };
    }
    current.text += line;
    if (shown && mark.startsWith(" [picture ")) current.pictures.push({ n, picture: shown });
  }
  if (current.text) windows.push(current);
  return windows.slice(-MAX_WINDOWS);
}

let files: { prompt: string; schema: Record<string, unknown> } | undefined;
function job() {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), "jobs", "extract");
  return (files ??= { prompt: fs.readFileSync(path.join(dir, "prompt.md"), "utf8"), schema: JSON.parse(fs.readFileSync(path.join(dir, "schema.json"), "utf8")) });
}

export type FoundNote = { problem: string; fix: string };

// The faults and fixes one piece of the chat shows as solved. A piece the model could not read
// gives none: the rest of the chat is still read.
export async function notesIn(client: ModelClient, window: ChatWindow | string): Promise<FoundNote[]> {
  const { prompt, schema } = job();
  const piece: ChatWindow = typeof window === "string" ? { text: window, pictures: [] } : window;
  try {
    const response = await client.complete({
      system: prompt,
      schema,
      content: [
        ...piece.pictures.flatMap(({ n, picture }) => [{ type: "text" as const, text: `picture ${n}:` }, { type: "image" as const, mediaType: picture.mediaType, data: picture.data }]),
        { type: "text" as const, text: `<chat>\n${piece.text.replace(/<\/?chat>/gi, "")}\n</chat>` },
      ],
    });
    const reply = JSON.parse(response.text ?? "") as { notes?: { problem?: unknown; fix?: unknown; confirmed?: unknown }[] };
    return (reply.notes ?? [])
      .filter((n) => n.confirmed === true && typeof n.problem === "string" && typeof n.fix === "string" && n.problem.trim().length > 5 && n.fix.trim().length > 5)
      .slice(0, 8)
      .map((n) => ({ problem: String(n.problem).trim().slice(0, 500), fix: String(n.fix).trim().slice(0, 600) }));
  } catch {
    return [];
  }
}

export const noteText = (n: FoundNote) => `תקלה: ${n.problem}\nפתרון: ${n.fix}`;

// The whole import: read, remove people, pick out what was solved. Nothing is stored here.
export async function notesFromChat(client: ModelClient, raw: string, pictures: Map<string, ChatPicture> = new Map()): Promise<{ messages: number; notes: FoundNote[]; pictures: number }> {
  const messages = withoutPeople(parseChat(raw));
  const found: FoundNote[] = [];
  const windows = chatWindows(messages, pictures);
  for (let i = 0; i < windows.length; i += 3) {
    const part = await Promise.all(windows.slice(i, i + 3).map((w) => notesIn(client, w)));
    found.push(...part.flat());
  }
  // A fix that the people-remover could not clean of a number is cleaned once more.
  return { messages: messages.length, pictures: windows.reduce((sum, w) => sum + w.pictures.length, 0), notes: found.map((n) => ({ problem: n.problem.replace(PHONE, "[מספר]"), fix: n.fix.replace(PHONE, "[מספר]") })) };
}
