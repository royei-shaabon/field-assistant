// Opens a chat exported from WhatsApp in the implementer's own browser. The export is either
// the chat's text file, or a zip that holds it with the media. From a zip only two things leave
// the browser: the text, and the pictures the chat names, each made small. The zip itself, the
// videos and the voice notes never go anywhere.
const MAX_PICTURES = 30;
const SIDE = 1024;

export type ChatExport = { chat: string; pictures: { name: string; data: string }[] };

const NAMED = /<attached:\s*([^>]{1,120}\.(?:jpe?g|png|webp))>|(\S{1,120}\.(?:jpe?g|png|webp))\s*\((?:file attached|קובץ מצורף)\)/gi;

async function small(blob: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.7);
    return url.slice(url.indexOf(",") + 1);
  } catch {
    return null;
  }
}

export async function readChatExport(file: File): Promise<ChatExport> {
  if (!/\.zip$/i.test(file.name) && file.type !== "application/zip") return { chat: await file.text(), pictures: [] };
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const text = entries.find((f) => /\.txt$/i.test(f.name));
  if (!text) return { chat: "", pictures: [] };
  const chat = await text.async("string");
  // The newest pictures the chat names: the import reads the newest part of a long chat.
  const names = [...new Set([...chat.matchAll(NAMED)].map((m) => (m[1] ?? m[2]).trim()))].slice(-MAX_PICTURES);
  const pictures: ChatExport["pictures"] = [];
  for (const name of names) {
    const entry = entries.find((f) => f.name === name || f.name.endsWith(`/${name}`));
    const data = entry ? await small(await entry.async("blob")) : null;
    if (data) pictures.push({ name, data });
  }
  return { chat, pictures };
}
