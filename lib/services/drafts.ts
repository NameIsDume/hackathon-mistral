// GDPR drafts (CNIL notification with AI narratives, breach register): built from the current snapshot and
// recorded as a `draft` event. A draft is never "sent". Throws VersionConflict if the facts changed meanwhile.
import { randomUUID } from "node:crypto";
import { draftNarrative } from "@/lib/adapters/mistral";
import { listEvents, loadSnapshot, recordEvent } from "@/lib/adapters/supabase";
import { evaluate } from "@/lib/regulations/gdpr";
import { breachRegister, cnilNotification, toMarkdown } from "@/lib/regulations/gdpr/templates";

export type DraftDocument = "cnil_notification" | "breach_register";

export async function buildDraft(incidentId: string, document: DraftDocument, idempotencyKey: string = randomUUID()) {
  const [snapshot, events] = await Promise.all([loadSnapshot(incidentId), listEvents(incidentId)]);
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

  await recordEvent({
    incidentId,
    expectedVersion: snapshot.version,
    actor: "system",
    event: { type: "draft", document, status: "draft" },
    idempotencyKey,
  });
  return { document: doc, markdown: toMarkdown(doc) };
}
