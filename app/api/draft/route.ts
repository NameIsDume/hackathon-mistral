// POST { incidentId, document } -> GDPR draft (JSON + markdown). Records a `draft` event; a draft is never "sent".
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { draftNarrative } from "@/lib/adapters/mistral";
import { IncidentNotFound, listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { requireDemoKey } from "@/lib/demo-auth";
import { evaluate } from "@/lib/regulations/gdpr";
import { breachRegister, cnilNotification, toMarkdown } from "@/lib/regulations/gdpr/templates";

const Body = z.object({ incidentId: z.uuid(), document: z.enum(["cnil_notification", "breach_register"]) });

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });
  const { incidentId, document } = body.data;

  let snapshot, events;
  try {
    [snapshot, events] = await Promise.all([loadSnapshot(incidentId), listEvents(incidentId)]);
  } catch (e) {
    if (e instanceof IncidentNotFound) return Response.json({ error: "incident not found" }, { status: 404 });
    throw e;
  }
  const assessment = evaluate(snapshot);
  let doc;
  if (document === "cnil_notification") {
    const signal = AbortSignal.timeout(12_000); // both narratives share one budget
    const [nature, consequences] = await Promise.all([
      draftNarrative("nature", snapshot.facts, signal),
      draftNarrative("consequences", snapshot.facts, signal),
    ]);
    doc = cnilNotification(snapshot, assessment, events, { nature, consequences });
  } else doc = breachRegister(snapshot, assessment, events);

  try {
    await recordEvent({
      incidentId,
      expectedVersion: snapshot.version,
      actor: "system",
      event: { type: "draft", document, status: "draft" },
      idempotencyKey: randomUUID(),
    });
  } catch (e) {
    if (e instanceof VersionConflict) return Response.json({ error: "facts changed, regenerate the draft" }, { status: 409 });
    throw e;
  }
  return Response.json({ status: "draft", document: doc, markdown: toMarkdown(doc) });
}
