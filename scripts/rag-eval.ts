// Measures retrieval on a deployed service: asks every question in tests/eval/rag-questions.json
// through the live call's lookup (search, then the second look) and checks that a page which
// answers it comes back, and how high. Run it before and after a change to search, sections,
// the meaning index or the rerank job.
//
// Usage: RAG_EVAL_PASSWORD=<admin password of the main environment> npm run rag-eval -- https://<service-url> [--hebrew-only] [--chat[=N]]
// --chat asks every Nth question (default 3) through the full checked-answer engine instead:
// was it answered, does a step cite a page that answers it, how many steps, and how long to
// the first step and to the end. This calls the main model and costs accordingly.
// --hebrew-only leaves out the English form of each question (the harder case: the service
// writes the English itself). The questions are written to the service's conversation log,
// under the conversation id "eval-rag", which the service answers but does not write to its log or count.
import fs from "node:fs";
import path from "node:path";

// `pages`: pages of the set's first document that answer. A key named after another document of
// the set (see `docs`) lists the pages of that one.
type Question = { he: string; en: string; pages: number[] } & Record<string, unknown>;

// Does this source (a document's title and a page number) answer the question? A set with no
// `docs` has one document, and only the page is compared.
function answers(set: { docs?: Record<string, string> }, q: Question, title: string, page: number): boolean {
  const names = Object.entries(set.docs ?? {});
  if (!names.length) return q.pages.includes(page);
  return names.some(([name, pattern], i) => new RegExp(pattern, "i").test(title) && ((i === 0 ? q.pages : (q[name] as number[] | undefined)) ?? []).includes(page));
}
const wanted = (set: { docs?: Record<string, string> }, q: Question) =>
  Object.keys(set.docs ?? { "": "" }).map((name, i) => { const p = (i === 0 ? q.pages : (q[name] as number[] | undefined)) ?? []; return p.length ? `${i ? `${name} ` : ""}${p.join(",")}` : ""; }).filter(Boolean).join(" / ");
// `outside`: a question the manual does not answer, with the kinds of reply that are acceptable.
type Outside = { he: string; kinds: string[]; caution: boolean | null };
type QuestionSet = { env: string; kb: string; docs?: Record<string, string>; questions: Question[]; outside?: Outside[] };

// Which build answers: printed first, so a result is never read against the wrong version.
const base = process.argv[2]?.replace(/\/$/, "");
const password = process.env.RAG_EVAL_PASSWORD;
if (!base?.startsWith("http") || !password) throw new Error("usage: RAG_EVAL_PASSWORD=... npm run rag-eval -- https://<service-url> [--hebrew-only]");
const hebrewOnly = process.argv.includes("--hebrew-only");
const chatArg = process.argv.find((a) => a === "--chat" || a.startsWith("--chat="));
// --first-search=parallel|sequential|meaning asks the service to run a chat answer's first search that way (an experiment).
const firstSearch = process.argv.find((a) => a.startsWith("--first-search="))?.split("=")[1];
// --no-page-images answers without the manual pages as pictures (an experiment: what do they cost?).
const noPageImages = process.argv.includes("--no-page-images");
const chatEvery = chatArg ? Math.max(1, Number(chatArg.split("=")[1]) || 3) : 0;

type ChatStep = { source?: { n?: number; docName?: string } };
type ChatResult = { kind?: string; steps?: ChatStep[]; ideas?: unknown[]; caution?: string };

// One question through /api/conversation: the stream's lines as they come, for the time of the first step.
async function askChat(cookie: string, set: QuestionSet, q: { he: string }): Promise<{ result: ChatResult | null; first: number | null; total: number }> {
  // The service allows a bounded number of questions in five minutes: wait and ask again.
  let started = Date.now();
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    started = Date.now();
    res = await fetch(`${base}/api/conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "x-ridd-env": set.env, "x-ridd-measuring": "1", ...(firstSearch ? { "x-first-search": firstSearch } : {}), ...(noPageImages ? { "x-page-images": "off" } : {}) },
      body: JSON.stringify({ kbId: set.kb, events: [], input: { kind: "ask", text: q.he }, conversationId: "eval-rag-chat", channel: "chat" }),
    });
    if (res.status !== 429 || attempt >= 8) break;
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  let first: number | null = null;
  let result: ChatResult | null = null;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const row = (() => {
        try {
          return JSON.parse(line) as { partial?: unknown; result?: { events?: { result?: ChatResult }[] } };
        } catch {
          return null;
        }
      })();
      if (row?.partial && first === null) first = Date.now() - started;
      if (row?.result) result = row.result.events?.at(-1)?.result ?? null;
    }
  }
  return { result, first, total: Date.now() - started };
}

async function chat(cookie: string): Promise<number> {
  let bad = 0;
  for (const set of sets) {
    const rows: { answered: boolean; cited: boolean; steps: number; first: number | null; total: number; caution: boolean }[] = [];
    for (const q of set.questions.filter((_, i) => i % chatEvery === 0)) {
      const { result, first, total } = await askChat(cookie, set, q);
      const sources = (result?.steps ?? []).flatMap((s) => (typeof s.source?.n === "number" ? [{ n: s.source.n, title: String(s.source.docName ?? "") }] : []));
      const pages = sources.map((s) => s.n);
      const row = { answered: result?.kind === "answer", cited: sources.some((s) => answers(set, q, s.title, s.n)), steps: result?.steps?.length ?? 0, first, total, caution: Boolean(result?.caution) };
      rows.push(row);
      if (!row.answered || !row.cited) console.log(`${row.answered ? "WRONG PAGE" : `NOT ANSWERED (${result?.kind ?? "no result"})`} ${q.he}  want ${wanted(set, q)}  cited ${[...new Set(pages)].join(",") || "-"}`);
    }
    const n = rows.length;
    const median = (values: number[]) => (values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0);
    console.log(
      `${set.kb} (${set.env}) answers: answered ${rows.filter((r) => r.answered).length}/${n}, cite a page that answers ${rows.filter((r) => r.cited).length}/${n}, ` +
        `steps per answer ${(rows.reduce((sum, r) => sum + r.steps, 0) / Math.max(1, n)).toFixed(1)}, first step ${median(rows.flatMap((r) => (r.first === null ? [] : [r.first])))} ms, whole answer ${median(rows.map((r) => r.total))} ms, warnings ${rows.filter((r) => r.caution).length}/${n}`,
    );
    bad += rows.filter((r) => !r.answered || !r.cited).length;
    // Outside the manual: the reply must be of an acceptable kind, never invented steps, and warn where it should.
    let fit = 0;
    let ideas = 0;
    const outside = set.outside ?? [];
    for (const q of outside) {
      const { result } = await askChat(cookie, set, q);
      const kind = result?.kind ?? "no result";
      const warned = Boolean(result?.caution) || kind === "hazard";
      const ok = q.kinds.includes(kind) && (q.caution === null || q.caution === warned);
      if (ok) fit++;
      else console.log(`OUTSIDE: got ${kind}${warned ? " with a warning" : ""} for ${q.he}  (acceptable: ${q.kinds.join(", ")}${q.caution === null ? "" : q.caution ? ", warned" : ", not warned"})`);
      if ((result?.ideas?.length ?? 0) > 0) ideas++;
    }
    if (outside.length) console.log(`${set.kb} (${set.env}) outside the manual: handled as expected ${fit}/${outside.length}, offered checks in ${ideas}/${outside.length}`);
    bad += outside.length - fit;
  }
  return bad;
}
const { sets } = JSON.parse(fs.readFileSync(path.resolve("tests", "eval", "rag-questions.json"), "utf8")) as { sets: QuestionSet[] };

async function main() {
  // The main environment's implementer may enter every environment.
  const login = await fetch(`${base}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!login.ok || !cookie) throw new Error(`login failed: HTTP ${login.status}`);

  const version = (await fetch(`${base}/api/version`).then((r) => r.json()).catch(() => null)) as { build?: string } | null;
  console.log(`build ${version?.build ?? "unknown (before the version endpoint)"}${hebrewOnly ? ", Hebrew only" : ""}`);
  if (chatEvery) {
    process.exitCode = (await chat(cookie)) ? 1 : 0;
    return;
  }
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
          headers: { "Content-Type": "application/json", Cookie: cookie, "x-ridd-env": set.env, "x-ridd-measuring": "1" },
          body: JSON.stringify({ kbId: set.kb, question: q.he, conversationId: "eval-rag", ...(hebrewOnly ? {} : { english: q.en }) }),
        });
        if (res.status !== 429 || attempt >= 12) break;
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
      const ms = Date.now() - started;
      const body = (await res.json().catch(() => null)) as { passages?: { source: string }[]; caution?: string; error?: string } | null;
      // A source reads "<document>, <page word> <number>": the number is the last one in it.
      const got = (body?.passages ?? []).map((p) => Number(/(\d+)\s*$/.exec(p.source)?.[1]));
      const rank = (body?.passages ?? []).findIndex((p, i) => answers(set, q, p.source, got[i])) + 1;
      rows.push({ rank, ms, caution: Boolean(body?.caution) });
      if (rank !== 1) console.log(`${rank ? `rank ${rank}` : "MISS  "} ${q.he}  want ${wanted(set, q)}  got ${got.join(",") || body?.error || `HTTP ${res.status}`}`);
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
