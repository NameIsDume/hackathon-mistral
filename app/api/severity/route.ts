// POST { incidentId, value, by } -> a human confirms or corrects the AI-proposed severity. Records `severity_confirmed`.
import { z } from "zod";
import { IncidentNotFound, VersionConflict } from "@/lib/adapters/supabase";
import { requireDemoKey } from "@/lib/demo-auth";
import { Role, Severity } from "@/lib/domain";
import { confirmSeverity } from "@/lib/services/review";

const Body = z.object({ incidentId: z.uuid(), value: Severity, by: z.object({ role: Role, name: z.string().min(1) }) });

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

  try {
    const version = await confirmSeverity(body.data.incidentId, body.data.value, body.data.by);
    return Response.json({ version });
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    if (e instanceof VersionConflict) return Response.json({ error: "incident changed, reload and retry" }, { status: 409 });
    throw e;
  }
}
