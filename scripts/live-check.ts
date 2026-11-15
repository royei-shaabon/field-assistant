// Asks a deployed service a fixed set of questions and reports what came back and how long it
// took. Usage: tsx scripts/live-check.ts https://<service-url> [kbId]
// The technician access code, when the service needs one, goes in ACCESS_TOKEN (or is added by
// the network layer as the x-access-token header).
const base = process.argv[2]?.replace(/\/$/, "");
if (!base) throw new Error("usage: tsx scripts/live-check.ts https://<service-url> [kbId]");
const headers: Record<string, string> = { "Content-Type": "application/json", "x-access-token": process.env.ACCESS_TOKEN ?? "placeholder" };

const QUESTIONS = [
  "מה לחץ האוויר בצמיגים?",
  "איך בודקים את מפלס שמן המנוע?",
  "איזה שמן מנוע צריך וכמה?",
  "כמה חופש צריך להיות בשרשרת?",
  "איפה נמצאים הפיוזים?",
  "המנוע לא מתניע, מה בודקים?",
  "נורית ה-ABS נשארת דולקת, מה זה אומר?",
  "איזה דלק לתדלק?",
  "איך בודקים את נוזל הבלמים?",
  "מה נפח מיכל הדלק?",
  "כל כמה זמן מחליפים שמן?",
  "מה המחיר של האופנוע בישראל?", // should not be in a manual
  // Faults a manual rarely covers: the answer should be suggested checks, marked as not from the manual.
  "האופנוע רועד בכידון מעל 100 קמ\"ש, מה לבדוק?",
  "יש רעש תקתוק מהמנוע כשהוא קר, מה זה יכול להיות?",
  "המצבר מתרוקן אחרי כמה ימים שהאופנוע עומד, למה?",
  "יש ריח דלק חזק ליד המנוע, מה לבדוק?", // hazard topic: no suggestions
];

type Step = { text: string; quote: string; source: { docName: string; n: number } };
type Idea = { text: string; why: string; likelihood: string; minutes: number };
type Item = { kind: string; ideas?: Idea[]; title?: string; steps?: Step[]; question?: string; options?: string[]; caution?: string; topic?: string };

type Timing = { plan: number; search: number; images: number; turns: { firstText: number | null; total: number; skill: boolean }[]; skills: number; firstStep: number | null; total: number };

type Figure = { caption: string; box: { x: number; y: number; w: number; h: number }; source: { n: number } };

async function ask(kbId: string, text: string) {
  const started = Date.now();
  const res = await fetch(`${base}/api/conversation`, { method: "POST", headers, body: JSON.stringify({ kbId, events: [], input: { kind: "ask", text } }) });
  if (!res.ok || !res.body) return { ms: Date.now() - started, error: `HTTP ${res.status}`, progress: [] as string[] };
  const progress: string[] = [];
  let item: (Item & { figures?: Figure[] }) | undefined;
  let error: string | undefined;
  let firstStep: number | undefined;
  let partials = 0;
  let timing: Timing | undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { progress?: string; detail?: string; partial?: unknown; timing?: Timing; result?: { screen: { items: Item[] } }; error?: string };
      if (msg.timing) timing = msg.timing;
      if (msg.progress) progress.push(msg.detail ? `${msg.progress}(${msg.detail})` : msg.progress);
      if (msg.partial) {
        partials++;
        firstStep ??= Date.now() - started;
      }
      if (msg.result) item = msg.result.screen.items.at(-1);
      if (msg.error) error = msg.error;
    }
    if (done) break;
  }
  return { ms: Date.now() - started, item, error, progress, firstStep, partials, timing };
}

(async () => {
  const list = await fetch(`${base}/api/kbs`, { headers });
  if (!list.ok) throw new Error(`GET /api/kbs -> HTTP ${list.status}`);
  const { kbs } = (await list.json()) as { kbs: { id: string; name: string; documents: number }[] };
  console.log("knowledge bases:", kbs.map((k) => `${k.id} (${k.documents} docs)`).join(", "));
  const kbId = process.argv[3] ?? kbs[0]?.id;
  const tally: Record<string, number> = {};
  const times: number[] = [];
  const firsts: number[] = [];
  const stages: { plan: number; search: number; images: number; firstText: number; writing: number; server: number; network: number; turns: number }[] = [];
  for (const q of QUESTIONS) {
    const r = await ask(kbId, q);
    const kind = r.error ? "ERROR" : (r.item?.kind ?? "none");
    tally[kind] = (tally[kind] ?? 0) + 1;
    times.push(r.ms);
    if (r.firstStep) firsts.push(r.firstStep);
    console.log(`\n### ${q}\n${kind}${r.item?.caution ? ` [caution: ${r.item.caution}]` : ""} in ${(r.ms / 1000).toFixed(1)}s, first step at ${r.firstStep ? (r.firstStep / 1000).toFixed(1) + "s" : "-"} (${r.partials ?? 0} partials)   ${r.progress.join(" > ")}`);
    if (r.timing) {
      const t = r.timing;
      const last = t.turns.at(-1);
      // "writing": from the main model's first text until it finished its answer.
      const row = { plan: t.plan, search: t.search, images: t.images, firstText: t.turns[0]?.firstText ?? t.turns[0]?.total ?? 0, writing: last ? last.total - (last.firstText ?? 0) : 0, server: t.total, network: r.ms - t.total, turns: t.turns.length };
      stages.push(row);
      console.log(`  timing: plan ${row.plan} | search ${row.search} | images ${row.images} | model first text ${row.firstText} | writing ${row.writing} | model calls ${row.turns} | server total ${row.server} | outside the server ${row.network} ms`);
    }
    for (const f of r.item?.figures ?? []) console.log(`  figure p.${f.source.n} "${f.caption}" box ${JSON.stringify(f.box)}`);
    if (r.error) console.log("  error:", r.error);
    if (r.item?.title) console.log("  title:", r.item.title);
    for (const s of r.item?.steps ?? []) console.log(`  - ${s.text}\n      [${s.source.docName} p.${s.source.n}] "${s.quote}"`);
    for (const i of r.item?.ideas ?? []) console.log(`  ? [${i.likelihood}, ${i.minutes} min] ${i.text}\n      why: ${i.why}`);
    if (r.item?.question) console.log("  asks:", r.item.question, r.item.options);
  }
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
  if (stages.length) {
    console.log("\n=== where the time goes (median ms) ===");
    for (const key of ["plan", "search", "images", "firstText", "writing", "server", "network"] as const) console.log(`${key.padEnd(10)} ${median(stages.map((s) => s[key]))}`);
    console.log(`answers that needed more than one model call: ${stages.filter((s) => s.turns > 1).length} of ${stages.length}`);
  }
  times.sort((a, b) => a - b);
  console.log("\n=== summary ===");
  console.log(tally);
  firsts.sort((a, b) => a - b);
  if (firsts.length) console.log(`first step: median ${(firsts[Math.floor(firsts.length / 2)] / 1000).toFixed(1)}s, slowest ${(firsts.at(-1)! / 1000).toFixed(1)}s`);
  console.log(`time: median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s, slowest ${(times.at(-1)! / 1000).toFixed(1)}s`);
})();
