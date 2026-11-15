import { technicianAllowed } from "@/lib/server/access";
import { kbStore } from "@/lib/store";

// The original document, so a source chip can open the manual at the cited page.
export async function GET(_request: Request, { params }: { params: Promise<{ kbId: string; docId: string }> }) {
  if (!(await technicianAllowed())) return new Response("access code required", { status: 401 });
  const { kbId, docId } = await params;
  const found = await kbStore().getDocFile(kbId, docId);
  if (!found) return new Response("not found", { status: 404 });
  const name = encodeURIComponent(`${found.meta.name}${found.meta.ext}`);
  return new Response(new Uint8Array(found.data), {
    headers: {
      "Content-Type": found.meta.mime,
      "Content-Disposition": `inline; filename*=UTF-8''${name}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      // An uploaded HTML file must never run as a page of this site. A PDF is left alone:
      // the browser's own PDF viewer does not open inside a sandbox.
      ...(found.meta.ext === ".pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" }),
    },
  });
}
