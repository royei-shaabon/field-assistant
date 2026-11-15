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
];

type Step = { text: string; quote: string; source: { docName: string; n: number } };
type Item = { kind: string; title?: string; steps?: Step[]; question?: string; options?: string[]; caution?: string; topic?: string };

async function ask(kbId: string, text: string) {
  const started = Date.now();
  const res = await fetch(`${base}/api/conversation`, { method: "POST", headers, body: JSON.stringify({ kbId, events: [], input: { kind: "ask", text } }) });
  if (!res.ok) return { ms: Date.now() - started, error: `HTTP ${res.status}`, progress: [] as string[] };
  const progress: string[] = [];
  let item: Item | undefined;
  let error: string | undefined;
  for (const line of (await res.text()).split("\n").filter(Boolean)) {
    const msg = JSON.parse(line) as { progress?: string; detail?: string; result?: { screen: { items: Item[] } }; error?: string };
    if (msg.progress) progress.push(msg.detail ? `${msg.progress}(${msg.detail})` : msg.progress);
    if (msg.result) item = msg.result.screen.items.at(-1);
    if (msg.error) error = msg.error;
  }
  return { ms: Date.now() - started, item, error, progress };
}

(async () => {
  const list = await fetch(`${base}/api/kbs`, { headers });
  if (!list.ok) throw new Error(`GET /api/kbs -> HTTP ${list.status}`);
  const { kbs } = (await list.json()) as { kbs: { id: string; name: string; documents: number }[] };
  console.log("knowledge bases:", kbs.map((k) => `${k.id} (${k.documents} docs)`).join(", "));
  const kbId = process.argv[3] ?? kbs[0]?.id;
  const tally: Record<string, number> = {};
  const times: number[] = [];
  for (const q of QUESTIONS) {
    const r = await ask(kbId, q);
    const kind = r.error ? "ERROR" : (r.item?.kind ?? "none");
    tally[kind] = (tally[kind] ?? 0) + 1;
    times.push(r.ms);
    console.log(`\n### ${q}\n${kind}${r.item?.caution ? ` [caution: ${r.item.caution}]` : ""} in ${(r.ms / 1000).toFixed(1)}s   ${r.progress.join(" > ")}`);
    if (r.error) console.log("  error:", r.error);
    if (r.item?.title) console.log("  title:", r.item.title);
    for (const s of r.item?.steps ?? []) console.log(`  - ${s.text}\n      [${s.source.docName} p.${s.source.n}] "${s.quote}"`);
    if (r.item?.question) console.log("  asks:", r.item.question, r.item.options);
  }
  times.sort((a, b) => a - b);
  console.log("\n=== summary ===");
  console.log(tally);
  console.log(`time: median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s, slowest ${(times.at(-1)! / 1000).toFixed(1)}s`);
})();
