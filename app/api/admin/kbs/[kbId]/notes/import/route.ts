import { MAX_CHAT_BYTES, NotAChat, notesFromChat, noteText } from "@/lib/docs/whatsapp";
import { AnthropicModelClient } from "@/lib/llm";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { currentEnvId, envStore } from "@/lib/server/env";
import { span } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

let client: AnthropicModelClient | undefined;

// A chat exported from a technicians' group, as text. Names and numbers are removed before a
// model sees anything, the file is not kept, and what was found waits as notes for approval.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`import-chat:${clientKey(request)}`, LIMITS.importChat)) return tooMany();
  if (tooLarge(request, MAX_CHAT_BYTES + 1000)) return Response.json({ error: "too_large" }, { status: 413 });
  const { kbId } = await params;
  const raw = await request.text().catch(() => "");
  if (!raw.trim() || Buffer.byteLength(raw) > MAX_CHAT_BYTES) return Response.json({ error: "file" }, { status: 400 });
  const stage = span("notes.import", { env: await currentEnvId(), kb: kbId, bytes: Buffer.byteLength(raw) });
  try {
    const store = await envStore();
    if (!(await store.getKb(kbId))) {
      stage.end({ outcome: "not_found" });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    client ??= new AnthropicModelClient();
    const { messages, notes } = await notesFromChat(client, raw);
    stage.part("model");
    let added = 0;
    for (const n of notes) {
      const before = (await store.listNotes(kbId)).length;
      await store.addNote(kbId, { text: noteText(n), from: "whatsapp" }).catch(() => null);
      if ((await store.listNotes(kbId)).length > before) added++;
    }
    stage.part("store");
    stage.end({ outcome: "read", messages, found: notes.length, added });
    return Response.json({ messages, found: notes.length, added });
  } catch (e) {
    if (e instanceof NotAChat) {
      stage.end({ outcome: "not_a_chat" });
      return Response.json({ error: "file" }, { status: 400 });
    }
    stage.fail(e);
    return Response.json({ error: "import_failed" }, { status: 502 });
  }
}
