import { currentEnvId, envStore } from "@/lib/server/env";
import { pageImage } from "@/lib/docs/page-image";
import { technicianAllowed } from "@/lib/server/access";

// One page of a PDF document as an image: what an answer shows as "from the manual".
export async function GET(_request: Request, { params }: { params: Promise<{ kbId: string; docId: string; n: string }> }) {
  if (!(await technicianAllowed())) return new Response("access code required", { status: 401 });
  const { kbId, docId, n } = await params;
  const image = /^[a-z0-9][a-z0-9-]{1,60}$/.test(kbId) && /^[a-z0-9][a-z0-9-]{1,60}$/.test(docId) ? await pageImage(kbId, docId, Number(n), await envStore(), await currentEnvId()) : null;
  if (!image) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(image.png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}
