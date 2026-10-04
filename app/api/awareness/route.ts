// POST { incidentId, at, by } -> the coordinator records when the controller became aware (R05).
// Starts the legal 72 h clock; a correction is a new `awareness` event and never restarts anything.
import { z } from "zod";
import { IncidentNotFound, VersionConflict } from "@/lib/adapters/supabase";
import { requireDemoKey } from "@/lib/demo-auth";
import { Role } from "@/lib/domain";
import { InvalidAwareness, setAwareness } from "@/lib/services/review";

const Body = z.object({
  incidentId: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  by: z.object({ role: Role, name: z.string().min(1) }),
});

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

  try {
    const version = await setAwareness(body.data.incidentId, body.data.at, body.data.by);
    return Response.json({ version });
  } catch (e) {
    if (e instanceof InvalidAwareness) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    if (e instanceof VersionConflict) return Response.json({ error: "incident changed, reload and retry" }, { status: 409 });
    throw e;
  }
}
