// POST a DPO recommendation or a lawyer-signed decision on one obligation (Q9). 201 with the recorded `decision` event; a double submit records once.
import { z } from "zod";
import { IncidentNotFound, VersionConflict } from "@/lib/adapters/supabase";
import { requireDemoKey } from "@/lib/demo-auth";
import { Role } from "@/lib/domain";
import { decide, DECIDABLE_OBLIGATIONS, DecisionRefused } from "@/lib/services/decide";

const Body = z.object({
  incidentId: z.uuid(),
  obligationId: z.enum(DECIDABLE_OBLIGATIONS),
  stage: z.enum(["recommendation", "decision"]),
  choice: z.enum(["notify", "do_not_notify", "defer"]),
  reasons: z.object({
    factsReliedOn: z.array(z.string()).max(100),
    riskFactors: z.string().max(3000),
    exceptionRelied: z.string().max(3000).optional(),
    evidence: z.string().max(3000).optional(),
    delayReason: z.string().max(3000).optional(),
    freeText: z.string().max(3000).optional(),
  }),
  by: z.object({ role: Role, name: z.string().trim().min(1).max(200) }),
  overrideRecommendation: z.boolean().optional(),
});

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });
  try {
    const result = await decide(body.data);
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    if (e instanceof VersionConflict) return Response.json({ error: "facts changed meanwhile, review and sign again" }, { status: 409 });
    if (e instanceof DecisionRefused) return Response.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
