// Measures retrieval on a deployed service: asks every question in tests/eval/rag-questions.json
// through the live call's lookup (search, then the second look) and checks that a page which
// answers it comes back, and how high. Run it before and after a change to search, sections,
// the meaning index or the rerank job.
//
// Usage: RAG_EVAL_PASSWORD=<admin password of the main environment> npm run rag-eval -- https://<service-url> [--hebrew-only]
// --hebrew-only leaves out the English form of each question (the harder case: the service
// writes the English itself). The questions are written to the service's conversation log,
// under the conversation id "eval-rag".
import fs from "node:fs";
import path from "node:path";

type Question = { he: string; en: string; pages: number[] };
type QuestionSet = { env: string; kb: string; questions: Question[] };

// Which build answers: printed first, so a result is never read against the wrong version.
const base = process.argv[2]?.replace(/\/$/, "");
const password = process.env.RAG_EVAL_PASSWORD;
if (!base?.startsWith("http") || !password) throw new Error("usage: RAG_EVAL_PASSWORD=... npm run rag-eval -- https://<service-url> [--hebrew-only]");
const hebrewOnly = process.argv.includes("--hebrew-only");
const { sets } = JSON.parse(fs.readFileSync(path.resolve("tests", "eval", "rag-questions.json"), "utf8")) as { sets: QuestionSet[] };

async function main() {
  // The main environment's implementer may enter every environment.
  const login = await fetch(`${base}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!login.ok || !cookie) throw new Error(`login failed: HTTP ${login.status}`);

  const version = (await fetch(`${base}/api/version`).then((r) => r.json()).catch(() => null)) as { build?: string } | null;
  console.log(`build ${version?.build ?? "unknown (before the version endpoint)"}${hebrewOnly ? ", Hebrew only" : ""}`);
  let failed = 0;
  for (const set of sets) {
    const rows: { rank: number; ms: number; caution: boolean }[] = [];
    for (const q of set.questions) {
      // The service allows a bounded number of lookups in ten minutes: wait and ask again.
      let res: Response;
      let started = Date.now();
      for (let attempt = 0; ; attempt++) {
        started = Date.now();
        res = await fetch(`${base}/api/voice/lookup`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie, "x-ridd-env": set.env },
          body: JSON.stringify({ kbId: set.kb, question: q.he, conversationId: "eval-rag", ...(hebrewOnly ? {} : { english: q.en }) }),
        });
        if (res.status !== 429 || attempt >= 12) break;
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
      const ms = Date.now() - started;
      const body = (await res.json().catch(() => null)) as { passages?: { source: string }[]; caution?: string; error?: string } | null;
      // A source reads "<document>, <page word> <number>": the number is the last one in it.
      const got = (body?.passages ?? []).map((p) => Number(/(\d+)\s*$/.exec(p.source)?.[1]));
      const rank = got.findIndex((n) => q.pages.includes(n)) + 1;
      rows.push({ rank, ms, caution: Boolean(body?.caution) });
      if (rank !== 1) console.log(`${rank ? `rank ${rank}` : "MISS  "} ${q.he}  want ${q.pages.join(",")}  got ${got.join(",") || body?.error || `HTTP ${res.status}`}`);
    }
    const n = rows.length;
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const count = (ok: (rank: number) => boolean) => rows.filter((r) => ok(r.rank)).length;
    console.log(`${set.kb} (${set.env}): first ${count((r) => r === 1)}/${n}, in the top three ${count((r) => r >= 1 && r <= 3)}/${n}, found ${count((r) => r >= 1)}/${n}, median ${times[Math.floor(n / 2)]} ms, slowest tenth from ${times[Math.floor(n * 0.9)]} ms, warnings ${rows.filter((r) => r.caution).length}/${n}`);
    failed += count((r) => r === 0);
  }
  process.exitCode = failed ? 1 : 0;
}

void main();
