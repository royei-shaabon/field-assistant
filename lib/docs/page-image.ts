// A picture of one page of an uploaded PDF, so an answer can show the manual's own drawing.
// Rendered on first use and then kept in the store next to the document.
import { kbStore, type KbStore } from "../store";

const WIDTH = 1000;

export type PageImage = { png: Buffer; width: number; height: number };

// The last opened PDF stays parsed in memory: pages of one manual are asked for in bursts.
let open: { key: string; data: Uint8Array } | undefined;

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// `store` is the environment's store, and `scope` its name (two environments may use the same ids).
export async function pageImage(kbId: string, docId: string, n: number, store: KbStore = kbStore(), scope = ""): Promise<PageImage | null> {
  if (!Number.isInteger(n) || n < 1 || n > 5000) return null;
  const cached = await store.getPageImage(kbId, docId, n).catch(() => null);
  if (cached) return { png: cached, ...pngSize(cached) };

  const key = `${scope}/${kbId}/${docId}`;
  if (open?.key !== key) {
    const file = await store.getDocFile(kbId, docId);
    if (!file || file.meta.ext !== ".pdf" || n > file.meta.passages) return null;
    open = { key, data: new Uint8Array(file.data) };
  }
  try {
    const { renderPageAsImage } = await import("unpdf");
    // pdf.js takes ownership of the buffer it is given, so each render gets a copy.
    const out = await renderPageAsImage(open.data.slice(), n, { canvasImport: () => import("@napi-rs/canvas"), width: WIDTH });
    const png = Buffer.from(out);
    await store.putPageImage(kbId, docId, n, png).catch(() => {});
    return { png, ...pngSize(png) };
  } catch (e) {
    console.error("[page image]", (e as Error).message);
    return null;
  }
}
