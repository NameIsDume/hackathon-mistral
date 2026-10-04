// POST { incidentId, value, by } -> a human confirms or corrects the AI-proposed severity. Records `severity_confirmed`.
import { after } from "next/server";
import { z } from "zod";
import { IncidentNotFound, VersionConflict } from "@/lib/adapters/supabase";
import { requireDemoKey } from "@/lib/demo-auth";
import { Role, Severity } from "@/lib/domain";
import { confirmSeverity } from "@/lib/services/review";
import { afterSeverityChange } from "@/lib/services/triggers";

const Body = z.object({ incidentId: z.uuid(), value: Severity, by: z.object({ role: Role, name: z.string().min(1) }) });

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

  try {
    const { incidentId, value, by } = body.data;
    const { version, previous } = await confirmSeverity(incidentId, value, by);
    // Roles the new severity adds get their DM once the response is sent (#40).
    after(() => afterSeverityChange(incidentId, previous, value).catch((e) => console.error("severity notify failed", e)));
    return Response.json({ version });
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    if (e instanceof VersionConflict) return Response.json({ error: "incident changed, reload and retry" }, { status: 409 });
    throw e;
  }
}
