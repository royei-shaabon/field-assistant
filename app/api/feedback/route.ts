import { envActivity, envStore } from "@/lib/server/env";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

// A technician marks an answer as helpful or not. Only the count is kept.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  if (!allow(`feedback:${clientKey(request)}`, LIMITS.ask)) return tooMany();
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; helpful?: unknown } | null;
  if (typeof body?.kbId !== "string" || typeof body.helpful !== "boolean") return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const helpful = body.helpful;
    await (await envStore()).recordFeedback(body.kbId, helpful);
    await (await envActivity()).measure((day) => void (helpful ? day.helpful++ : day.unhelpful++)).catch(() => {});
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
