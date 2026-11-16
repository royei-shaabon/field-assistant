import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnvId } from "@/lib/server/env";
import { log } from "@/lib/server/log";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";
import { activity } from "@/lib/store";
import { bump } from "@/lib/store/activity";
import { cleanSurvey } from "@/lib/survey";

// The technician's answers to the short survey after a call. Fixed choices only, no free text.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`survey:${clientKey(request)}`, LIMITS.ask)) return tooMany();
  if (tooLarge(request, 2000)) return Response.json({ error: "too large" }, { status: 413 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown; conversationId?: unknown; channel?: unknown; answers?: unknown } | null;
  const answers = cleanSurvey(body?.answers);
  if (!answers || typeof body?.kbId !== "string") return Response.json({ error: "bad request" }, { status: 400 });
  const envId = await currentEnvId();
  const book = activity(envId);
  await book.record({
    kbId: body.kbId.slice(0, 60),
    conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
    channel: body.channel === "video" ? "video" : "voice",
    question: "",
    kind: "survey",
    survey: answers,
  });
  await book.measure((day) => {
    day.surveys = (day.surveys ?? 0) + 1;
    if (answers.solved) bump((day.solved ??= {}), answers.solved);
    if (answers.improve) bump((day.improve ??= {}), answers.improve);
  });
  log.info("survey.done", { env: envId, solved: answers.solved, improve: answers.improve, again: answers.again });
  return Response.json({ ok: true });
}
