// Trigger the Slack DM wave for an incident (intake or demo button). Guarded by the demo key.
import { z } from "zod";
import { requireDemoKey } from "@/lib/demo-auth";
import { notifyWave } from "@/lib/services/notify";

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = z.object({ incidentId: z.uuid() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "incidentId (uuid) requis" }, { status: 400 });
  return Response.json({ results: await notifyWave(body.data.incidentId) });
}
