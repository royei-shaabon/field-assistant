// Request limits, kept in memory. The service runs as one instance (see scripts/deploy-gcp.sh),
// so one process sees every request; with several instances each would count on its own, and a
// restart clears the counts. The provider-side spend limit is the real backstop for cost.
type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();
const MAX_KEYS = 20_000;

export type Limit = { max: number; windowMs: number };

export const LIMITS = {
  // Guessing the admin password or the technician code: per caller, and for everyone together
  // (a caller can lie about its address, so the shared cap is what really bounds guessing).
  login: { max: 8, windowMs: 10 * 60_000 },
  loginAll: { max: 60, windowMs: 10 * 60_000 },
  // Questions cost model tokens: per phone, and for the whole service per day.
  ask: { max: 30, windowMs: 5 * 60_000 },
  askDaily: { max: Number(process.env.DAILY_QUESTION_LIMIT) || 1000, windowMs: 24 * 60 * 60_000 },
  upload: { max: 60, windowMs: 10 * 60_000 },
  // A large file comes in parts of 8MB: a few big manuals in ten minutes.
  uploadPart: { max: 400, windowMs: 10 * 60_000 },
  // Building the meaning index calls the embedding service: one call per ~45 seconds of work.
  index: { max: 120, windowMs: 10 * 60_000 },
  // Spoken lines in a call: a few per answer. New sentences cost; repeated ones come from the store.
  speak: { max: 240, windowMs: 5 * 60_000 },
  // Live calls: each one opens a session with the live model.
  live: { max: 20, windowMs: 10 * 60_000 },
  // The live call's tool: a search per question (an embedding call, no language model).
  lookup: { max: 120, windowMs: 10 * 60_000 },
  // A careful look at one picture in a video call: a call to the main model each time.
  look: { max: 90, windowMs: 10 * 60_000 },
  // The call's record, sent in pieces every few seconds.
  trace: { max: 400, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;

// True when the call is allowed; counts it.
export function allow(key: string, limit: Limit, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    if (windows.size >= MAX_KEYS) {
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
      // Still full of live windows: refuse new callers rather than grow without bound.
      if (windows.size >= MAX_KEYS) return false;
    }
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }
  w.count++;
  return w.count <= limit.max;
}

// Forgets a key, e.g. after a successful login.
export function reset(key: string): void {
  windows.delete(key);
}

// The caller's address. Google's front end appends the real address to whatever the client
// sent in X-Forwarded-For, so the last entry is the one the client cannot choose.
export function clientKeyFrom(forwarded: string | null): string {
  return forwarded?.split(",").at(-1)?.trim() || "unknown";
}

export function clientKey(request: Request): string {
  return clientKeyFrom(request.headers.get("x-forwarded-for"));
}

// Refuses a body that declares itself larger than the route can need, before it is read.
export function tooLarge(request: Request, maxBytes: number): boolean {
  const length = Number(request.headers.get("content-length") ?? 0);
  return length > maxBytes;
}

export const tooMany = () => Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
