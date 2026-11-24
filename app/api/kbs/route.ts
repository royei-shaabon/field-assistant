import { needsCode, technicianAllowed } from "@/lib/server/access";
import { currentEnv } from "@/lib/server/env";
import { listKbSummaries } from "@/lib/server/kbs";

// The knowledge bases a technician can work in.
export async function GET() {
  // A link to an environment that does not exist, or was turned off: say so, instead of asking
  // for a code that nothing would accept. The two cases look the same from outside.
  if (!(await currentEnv())) return Response.json({ error: "no_environment" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await technicianAllowed())) return needsCode();
  return Response.json({ kbs: await listKbSummaries() }, { headers: { "Cache-Control": "no-store" } });
}
