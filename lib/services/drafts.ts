// GDPR drafts (CNIL notification with AI first passes, breach register, notice to data subjects): built from the current
// snapshot and recorded as `draft` events. The lawyer approves "Likely consequences" and "Measures" (section_approved);
// the DPO records the transmission (sent). Throws VersionConflict if the facts changed meanwhile.
import { randomUUID } from "node:crypto";
import { draftNarrative } from "@/lib/adapters/mistral";
import { listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import type { DraftSection, IncidentEvent, Role } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { breachRegister, cnilNotification, draftState, subjectsNotice, toMarkdown, type GdprDocument } from "@/lib/regulations/gdpr/templates";

export type DraftDocument = "cnil_notification" | "breach_register" | "subjects_notice";
type By = { role: Role; name: string; slackUserId?: string };

export class DraftRefused extends Error {}

export async function buildDraft(incidentId: string, document: DraftDocument, idempotencyKey: string = randomUUID()) {
  const [snapshot, events] = await Promise.all([loadSnapshot(incidentId), listEvents(incidentId)]);
  const assessment = evaluate(snapshot);
  let doc: GdprDocument | null;
  let ai: Record<DraftSection, string | null> | undefined;
  if (document === "cnil_notification") {
    const signal = AbortSignal.timeout(12_000); // all narratives share one budget
    const [nature, consequences, measures] = await Promise.all(
      (["nature", "consequences", "measures"] as const).map((k) => draftNarrative(k, snapshot.facts, signal)),
    );
    ai = { consequences, measures }; // AI first pass, kept in the audit trail next to the lawyer's final text
    doc = cnilNotification(snapshot, assessment, events, { nature, consequences, measures });
  } else if (document === "subjects_notice") {
    doc = subjectsNotice(snapshot, events);
    if (!doc) throw new DraftRefused("The lawyer has not decided to inform the data subjects (Art. 34): no notice yet.");
  } else doc = breachRegister(snapshot, assessment, events);

  await recordEvent({
    incidentId,
    expectedVersion: snapshot.version,
    actor: "system",
    event: { type: "draft", document, status: "draft", ...(ai && { ai }) },
    idempotencyKey,
  });
  return { document: doc, markdown: toMarkdown(doc) };
}

// One `draft` event on the current version; one retry on a version conflict (these events never touch the facts).
async function record(incidentId: string, by: By, idempotencyKey: string, event: IncidentEvent, check: (s: ReturnType<typeof draftState>) => void) {
  for (let attempt = 0; ; attempt++) {
    const [snapshot, events] = await Promise.all([loadSnapshot(incidentId), listEvents(incidentId)]);
    check(draftState(events));
    try {
      return await recordEvent({ incidentId, expectedVersion: snapshot.version, actor: by.slackUserId ? `slack:${by.slackUserId}` : by.role, event, idempotencyKey });
    } catch (e) {
      if (!(e instanceof VersionConflict) || attempt > 0) throw e;
    }
  }
}

// The lawyer's final wording of one section (the AI first pass stays in the earlier `draft` event).
export async function approveSection(incidentId: string, section: DraftSection, text: string, by: By, idempotencyKey: string) {
  if (by.role !== "lawyer") throw new DraftRefused("Only the lawyer can approve a section.");
  if (!text.trim()) throw new DraftRefused("The approved text cannot be empty.");
  await record(incidentId, by, idempotencyKey, { type: "draft", document: "cnil_notification", status: "section_approved", section, text: text.trim(), by }, () => {});
}

// The DPO records that the CNIL notification was transmitted (distinct from the decision to notify).
export async function markSent(incidentId: string, sentAt: string, reference: string | null, by: By, idempotencyKey: string, now = new Date()) {
  if (by.role !== "dpo") throw new DraftRefused("Only the DPO can record the transmission.");
  if (!(Date.parse(sentAt) <= now.getTime() + 60_000)) throw new DraftRefused("The sending time cannot be in the future.");
  const event: IncidentEvent = { type: "draft", document: "cnil_notification", status: "sent", sentAt, by, ...(reference?.trim() && { reference: reference.trim() }) };
  await record(incidentId, by, idempotencyKey, event, (s) => {
    if (!s.readyToSend) throw new DraftRefused("Not ready to send: the lawyer has not approved the likely consequences and the measures.");
  });
}
