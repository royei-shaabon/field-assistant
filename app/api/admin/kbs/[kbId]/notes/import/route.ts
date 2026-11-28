import { MAX_CHAT_BYTES, MAX_PICTURES, NotAChat, notesFromChat, noteText, type ChatPicture } from "@/lib/docs/whatsapp";
import { AnthropicModelClient } from "@/lib/llm";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { span } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

let client: AnthropicModelClient | undefined;
const MAX_PICTURE_BASE64 = 500_000;
const MAX_IMPORT_BYTES = MAX_CHAT_BYTES + MAX_PICTURES * MAX_PICTURE_BASE64 + 100_000;

// A chat exported from a technicians' group, as text. Names and numbers are removed before a
// model sees anything, the file is not kept, and what was found waits as notes for approval.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`import-chat:${clientKey(request)}`, LIMITS.importChat)) return tooMany();
  // Text alone, or text with the chat's pictures (made small by the implementer's browser, which
  // opened the exported zip itself: the zip never comes here).
  const withPictures = (request.headers.get("content-type") ?? "").includes("application/json");
  if (tooLarge(request, withPictures ? MAX_IMPORT_BYTES : MAX_CHAT_BYTES + 1000)) return Response.json({ error: "too_large" }, { status: 413 });
  const { kbId } = await params;
  let raw = "";
  const pictures = new Map<string, ChatPicture>();
  if (withPictures) {
    const body = (await request.json().catch(() => null)) as { chat?: unknown; pictures?: unknown } | null;
    raw = typeof body?.chat === "string" ? body.chat : "";
    for (const p of (Array.isArray(body?.pictures) ? body.pictures : []).slice(0, MAX_PICTURES) as { name?: unknown; data?: unknown }[]) {
      // A JPEG as base64, bounded: anything else is left out, and the chat is still read.
      if (typeof p?.name === "string" && p.name.length <= 120 && typeof p.data === "string" && p.data.length <= MAX_PICTURE_BASE64 && /^\/9j\/[A-Za-z0-9+/=]+$/.test(p.data)) pictures.set(p.name, { data: p.data, mediaType: "image/jpeg" });
    }
  } else raw = await request.text().catch(() => "");
  if (!raw.trim() || Buffer.byteLength(raw) > MAX_CHAT_BYTES) return Response.json({ error: "file" }, { status: 400 });
  const stage = span("notes.import", { env: await currentEnvId(), kb: kbId, bytes: Buffer.byteLength(raw), pictures: pictures.size });
  try {
    const store = await envStore();
    if (!(await store.getKb(kbId))) {
      stage.end({ outcome: "not_found" });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    client ??= new AnthropicModelClient();
    const { messages, notes, pictures: shown } = await notesFromChat(client, raw, pictures);
    stage.part("model");
    let added = 0;
    for (const n of notes) {
      const before = (await store.listNotes(kbId)).length;
      await store.addNote(kbId, { text: noteText(n), from: "whatsapp" }).catch(() => null);
      if ((await store.listNotes(kbId)).length > before) added++;
    }
    stage.part("store");
    stage.end({ outcome: "read", messages, found: notes.length, added, pictures: shown });
    return Response.json({ messages, found: notes.length, added, pictures: shown });
  } catch (e) {
    if (e instanceof NotAChat) {
      stage.end({ outcome: "not_a_chat" });
      return Response.json({ error: "file" }, { status: 400 });
    }
    stage.fail(e);
    return Response.json({ error: "import_failed" }, { status: 502 });
  }
}
