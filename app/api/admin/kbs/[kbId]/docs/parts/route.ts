import { currentEnvId } from "@/lib/server/env";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { storeUpload } from "@/lib/server/store-upload";
import { joinParts, PART_BYTES, partsRoot, savePart, TooMuchWaiting, validPart, validUploadId } from "@/lib/server/upload-parts";

// A large document, in parts (see lib/server/upload-parts.ts).
//   POST ?id=<upload>&index=<n>&total=<parts>   body: the bytes of one part
//   POST ?id=<upload>&total=<parts>&finish=1    body: { fileName, name, origin, bytes }
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`upload-part:${clientKey(request)}`, LIMITS.uploadPart)) return tooMany();
  const { kbId } = await params;
  const query = new URL(request.url).searchParams;
  const id = query.get("id");
  const total = Number(query.get("total"));
  if (!validUploadId(id) || !validPart(0, total)) return Response.json({ error: "file" }, { status: 400 });
  const envId = await currentEnvId();
  const root = partsRoot(envId);

  if (query.get("finish") !== "1") {
    const index = Number(query.get("index"));
    if (!validPart(index, total)) return Response.json({ error: "file" }, { status: 400 });
    if (tooLarge(request, PART_BYTES + 1000)) return Response.json({ error: "too_large" }, { status: 413 });
    const data = Buffer.from(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (data.length === 0 || data.length > PART_BYTES) return Response.json({ error: "file" }, { status: 400 });
    try {
      await savePart(root, id, index, data);
    } catch (e) {
      if (e instanceof TooMuchWaiting) return Response.json({ error: "busy" }, { status: 429 });
      throw e;
    }
    return Response.json({ ok: true });
  }

  if (!allow(`upload:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  if (tooLarge(request, 10_000)) return Response.json({ error: "too_large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { fileName?: unknown; name?: unknown; origin?: unknown; bytes?: unknown } | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName.slice(0, 300) : "";
  const bytes = Number(body?.bytes);
  if (!fileName) return Response.json({ error: "file" }, { status: 400 });
  const data = await joinParts(root, id, total, bytes);
  if (!data) {
    log.warn("upload.incomplete", { env: envId, kb: kbId, parts: total });
    return Response.json({ error: "incomplete" }, { status: 400 });
  }
  return storeUpload({ envId, kbId, fileName, data, origin: body?.origin === "customer" ? "customer" : "manufacturer", given: typeof body?.name === "string" ? body.name : "", parts: total });
}
