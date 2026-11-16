// Conversations saved in this browser. Only the event log is stored; the server rebuilds the
// screen from it. Each conversation belongs to one knowledge base.
import type { DocEvent } from "../docs/conversation";
import type { Event } from "../orchestrator";
import type { Screen } from "../screen";

const KEY = "kb.conversations.v2";
const SELECTED = "kb.selected";
const KEEP = 20;
// Removed conversations are kept too, without their pictures, up to what the phone's storage holds.
const KEEP_HIDDEN = 200;

export type SavedConversation = {
  id: string;
  kbId: string;
  events: (Event | DocEvent)[];
  title?: string;
  mode: Screen["mode"];
  updatedAt: number;
  // Small copies of the photos / video frames, by event index. Kept only for the newest few.
  media?: Record<number, string[]>;
  // When each event was sent, by event index: the time shown in the corner of a message.
  times?: Record<number, number>;
  // Set when the technician removed the conversation from their list. It is hidden, never
  // erased from this phone (soft delete), so it can still be looked at later.
  deletedAt?: number;
};

const KEEP_MEDIA = 3;

const CHANGED = "kb-conversations-changed";

// For useSyncExternalStore: the raw stored string is the snapshot, so it compares stably.
export function conversationsSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function subscribeConversations(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function parseConversations(raw: string): SavedConversation[] {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// What the technician sees in the list: everything that was not removed.
export function visibleConversations(list: SavedConversation[]): SavedConversation[] {
  return list.filter((c) => !c.deletedAt);
}

function write(list: SavedConversation[]): void {
  const shown = visibleConversations(list)
    .slice(0, KEEP)
    .map((x, i) => (i < KEEP_MEDIA ? x : { ...x, media: undefined }));
  const hidden = list
    .filter((c) => c.deletedAt)
    .slice(0, KEEP_HIDDEN)
    .map((x) => ({ ...x, media: undefined }));
  const put = (items: SavedConversation[]) => localStorage.setItem(KEY, JSON.stringify(items));
  try {
    put([...shown, ...hidden]);
  } catch {
    // The phone's storage is full: the oldest removed conversations make room, the shown ones stay.
    try {
      put([...shown, ...hidden.slice(0, 20)]);
    } catch {
      // Storage blocked: the conversation still works, it just is not remembered.
      return;
    }
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function saveConversation(c: SavedConversation): void {
  write([c, ...parseConversations(conversationsSnapshot()).filter((x) => x.id !== c.id)]);
}

// Soft delete: the conversation leaves the list and stays on the phone, marked with the time.
export function deleteConversation(id: string, now = Date.now()): void {
  write(parseConversations(conversationsSnapshot()).map((x) => (x.id === id ? { ...x, deletedAt: now } : x)));
}

export function newConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Short case number shown to the technician, e.g. "K7Q2".
export function caseNumber(id: string): string {
  return id.split("-").at(-1)!.slice(0, 4).toUpperCase();
}

// The knowledge base this technician last worked in.
export function selectedKb(): string | null {
  try {
    return localStorage.getItem(SELECTED);
  } catch {
    return null;
  }
}

export function selectKb(id: string): void {
  try {
    localStorage.setItem(SELECTED, id);
  } catch {
    // Not remembered; the first knowledge base is used next time.
  }
}
