import { createLiveToken, liveSetup, liveSocketUrl, LIVE_MODEL } from "@/lib/voice/live";
import { needsCode, technicianAllowed } from "@/lib/server/access";
import { isAdmin } from "@/lib/server/admin-auth";
import { loadDocKb } from "@/lib/server/kbs";
import { allow, clientKey, LIMITS, tooLarge, tooMany } from "@/lib/server/rate-limit";

// Starts a live call: a one-use token for the phone to talk to the live model directly.
export async function POST(request: Request) {
  if (!(await technicianAllowed())) return needsCode();
  if (!allow(`live:${clientKey(request)}`, LIMITS.live)) return tooMany();
  if (tooLarge(request, 1000)) return Response.json({ error: "too large" }, { status: 413 });
  const key = process.env.GEMINI_API_KEY;
  // Not configured: the phone falls back to the call with the browser's voice.
  if (!key) return Response.json({ error: "live_off" }, { status: 409 });
  const body = (await request.json().catch(() => null)) as { kbId?: unknown } | null;
  const kb = typeof body?.kbId === "string" ? await loadDocKb(body.kbId) : null;
  if (!kb) return Response.json({ error: "unknown knowledge base" }, { status: 400 });
  try {
    const token = await createLiveToken(key, liveSetup(kb.meta.name));
    return Response.json({ url: liveSocketUrl(token), model: LIVE_MODEL() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[live]", (e as Error).message);
    // The provider's message (never the key) for the implementer; technicians get the fallback.
    return Response.json({ error: "live_failed", ...((await isAdmin()) ? { detail: (e as Error).message } : {}) }, { status: 502 });
  }
}
