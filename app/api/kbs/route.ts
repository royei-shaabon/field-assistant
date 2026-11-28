import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnv, envStore } from "@/lib/server/env";
import { listKbSummaries } from "@/lib/server/kbs";

// The knowledge bases a technician can work in.
export async function GET() {
  // A link to an environment that does not exist, or was turned off: say so, instead of asking
  // for a code that nothing would accept. The two cases look the same from outside.
  if (!(await currentEnv())) return Response.json({ error: "no_environment" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await technicianAllowed())) return needsCode();
  // The names to pick from, when the implementer keeps a list (see lib/client/who.ts).
  const technicians = (await (await envStore()).getSettings().catch(() => ({}) as { technicians?: string[] })).technicians ?? [];
  return Response.json({ kbs: await listKbSummaries(), ...(technicians.length ? { technicians } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
