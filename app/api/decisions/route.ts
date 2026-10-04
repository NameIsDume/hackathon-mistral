// GET ?incidentId= -> latest decision per obligation, "current" or "to_re_evaluate" (read-only),
// plus the current computed assessment so the form can show recommendation and decision side by side.
import { z } from "zod";
import { IncidentNotFound, listEvents, loadSnapshot } from "@/lib/adapters/supabase";
import { evaluate } from "@/lib/regulations/gdpr";
import { decisionStatus } from "@/lib/services/decide";

export async function GET(request: Request) {
  const incidentId = z.uuid().safeParse(new URL(request.url).searchParams.get("incidentId"));
  if (!incidentId.success) return Response.json({ error: "incidentId must be a uuid" }, { status: 400 });
  try {
    const [snapshot, events] = await Promise.all([loadSnapshot(incidentId.data), listEvents(incidentId.data)]);
    return Response.json({ assessment: evaluate(snapshot), decisions: decisionStatus(events) });
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    throw e;
  }
}
