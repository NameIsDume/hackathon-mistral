// GET ?incidentId= -> { snapshot, assessment, clocks }. Read-only, no demo key: anon can already read these columns.
// The snapshot never carries answer_token (loadSnapshot does not select it).
import type { NextRequest } from "next/server";
import { z } from "zod";
import { IncidentNotFound, loadSnapshot } from "@/lib/adapters/supabase";
import { deadline, type Clock } from "@/lib/clocks";
import { evaluate } from "@/lib/regulations/gdpr";

export async function GET(request: NextRequest) {
  const id = z.uuid().safeParse(request.nextUrl.searchParams.get("incidentId"));
  if (!id.success) return Response.json({ error: "incidentId must be a uuid" }, { status: 400 });

  let snapshot;
  try {
    snapshot = await loadSnapshot(id.data);
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    throw e;
  }
  const assessment = evaluate(snapshot);
  const now = new Date();
  const clocks: Record<string, Clock> = {};
  for (const o of assessment.obligations) if (o.deadline) clocks[o.id] = deadline(o.deadline, snapshot, now);
  return Response.json({ snapshot, assessment, clocks });
}
