import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BlobDriver } from "./types";

// Keys are forward-slash paths under one root directory. A key can never leave the root.
export class FsDriver implements BlobDriver {
  constructor(private root: string) {}

  private file(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== path.resolve(this.root) && !full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("bad key");
    return full;
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.file(key));
    } catch {
      return null;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write then rename, so a reader never sees half a file.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  async remove(prefix: string): Promise<void> {
    await fs.rm(this.file(prefix), { recursive: true, force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.file(prefix);
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith(".tmp")) out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(dir);
    return out.sort();
  }
}
