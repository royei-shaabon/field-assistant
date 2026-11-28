import { currentEnvId } from "@/lib/server/env";
import { forbidden, isAdmin } from "@/lib/server/admin-auth";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { storeUpload } from "@/lib/server/store-upload";
import { PART_BYTES } from "@/lib/server/upload-parts";

// Upload one document in one request: read it into passages, then store the passages and the
// original. A file larger than one part comes through ./parts instead.
export async function POST(request: Request, { params }: { params: Promise<{ kbId: string }> }) {
  if (!(await isAdmin())) return forbidden();
  if (!allow(`upload:${clientKey(request)}`, LIMITS.upload)) return tooMany();
  const { kbId } = await params;
  if (tooLarge(request, PART_BYTES + 100_000)) return Response.json({ error: "too_large" }, { status: 413 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file" }, { status: 400 });
  if (file.size > PART_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  const given = form?.get("name");
  return storeUpload({
    envId: await currentEnvId(),
    kbId,
    fileName: file.name,
    data: Buffer.from(await file.arrayBuffer()),
    origin: form?.get("origin") === "customer" ? "customer" : "manufacturer",
    given: typeof given === "string" ? given : "",
  });
}
