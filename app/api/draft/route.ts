// POST { incidentId, document } -> GDPR draft (JSON + markdown). Records a `draft` event; a draft is never "sent".
// subjects_notice: 409 until the lawyer decided to inform the data subjects.
import { z } from "zod";
import { IncidentNotFound, VersionConflict } from "@/lib/adapters/supabase";
import { requireDemoKey } from "@/lib/demo-auth";
import { buildDraft, DraftRefused } from "@/lib/services/drafts";

const Body = z.object({ incidentId: z.uuid(), document: z.enum(["cnil_notification", "breach_register", "subjects_notice"]) });

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

  try {
    const { document, markdown } = await buildDraft(body.data.incidentId, body.data.document);
    return Response.json({ status: "draft", document, markdown });
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    if (e instanceof VersionConflict) return Response.json({ error: "facts changed, regenerate the draft" }, { status: 409 });
    if (e instanceof DraftRefused) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
