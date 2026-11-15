import { needsCode, technicianAllowed } from "@/lib/server/access";
import { listKbSummaries } from "@/lib/server/kbs";

// The knowledge bases a technician can work in.
export async function GET() {
  if (!(await technicianAllowed())) return needsCode();
  return Response.json({ kbs: await listKbSummaries() }, { headers: { "Cache-Control": "no-store" } });
}
