// A large file arrives in parts. One request to the service cannot carry more than 32MB, so the
// implementer's browser cuts a file into parts and sends them one by one; the parts wait in the
// server's temporary folder, and the last request joins them into the file. The service runs as
// one instance, so every part reaches the same folder.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_UPLOAD_BYTES } from "@/lib/docs/ingest";

// Small enough for any network and far under the request limit of the service.
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_PARTS = Math.ceil(MAX_UPLOAD_BYTES / PART_BYTES);
// An upload that was abandoned is removed after this long.
const STALE_MS = 60 * 60_000;

const ID = /^[a-z0-9]{8,40}$/;
export const validUploadId = (id: unknown): id is string => typeof id === "string" && ID.test(id);
export const validPart = (index: number, total: number) => Number.isInteger(total) && total >= 1 && total <= MAX_PARTS && Number.isInteger(index) && index >= 0 && index < total;

// The environment's name passed the same pattern check as everywhere else before it gets here.
export const partsRoot = (envId: string, base = os.tmpdir()) => path.join(base, "ridd-uploads", envId);

export async function savePart(root: string, id: string, index: number, data: Buffer): Promise<void> {
  if (!validUploadId(id) || !Number.isInteger(index) || index < 0 || index >= MAX_PARTS) throw new Error("bad part");
  if (data.length === 0 || data.length > PART_BYTES) throw new Error("bad part size");
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, String(index)), data);
}

// Joins the parts in order. Null when a part is missing or the size is not what was declared:
// a file is never read from half an upload. The parts are removed either way.
export async function joinParts(root: string, id: string, total: number, bytes: number): Promise<Buffer | null> {
  if (!validUploadId(id) || !validPart(0, total) || !(bytes > 0) || bytes > MAX_UPLOAD_BYTES) return null;
  const dir = path.join(root, id);
  try {
    const parts: Buffer[] = [];
    let size = 0;
    for (let i = 0; i < total; i++) {
      const part = await fs.readFile(path.join(dir, String(i))).catch(() => null);
      if (!part) return null;
      size += part.length;
      if (size > bytes) return null;
      parts.push(part);
    }
    return size === bytes ? Buffer.concat(parts) : null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Removes uploads nobody finished.
export async function sweepParts(root: string, now = Date.now()): Promise<void> {
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    const at = await fs.stat(path.join(root, d)).then((s) => s.mtimeMs).catch(() => now);
    if (now - at > STALE_MS) await fs.rm(path.join(root, d), { recursive: true, force: true }).catch(() => {});
  }
}
