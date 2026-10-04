// Signed human decision on one GDPR obligation (R07, R10). The computed recommendation never decides:
// the DPO does, with written reasons (Art. 33(5)). History is never rewritten; a decision made before
// facts changed is shown "to re-evaluate".
import { createHash } from "node:crypto";
import type { IncidentEvent, IncidentSnapshot, Role } from "@/lib/domain";
import { listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { evaluate, GDPR_MODULE_VERSION } from "@/lib/regulations/gdpr";

// MVP: one sign-off by the DPO. Multi-person sign-off = widen this list (and count signatures).
export const SIGNER_ROLES: readonly Role[] = ["dpo"];
export const MIN_REASONS_LENGTH = 20;
export const DECIDABLE_OBLIGATIONS = ["gdpr.notify_authority", "gdpr.inform_subjects", "gdpr.notify_controller"] as const;

export type DecisionEvent = Extract<IncidentEvent, { type: "decision" }>;
export type LoggedEvent = { id: number; at: string; event: IncidentEvent };

export class DecisionRefused extends Error {}

export type DecideInput = {
  incidentId: string;
  obligationId: (typeof DECIDABLE_OBLIGATIONS)[number];
  choice: DecisionEvent["choice"];
  reasons: string;
  by: { role: Role; name: string };
  overrideRecommendation?: boolean;
};

// Events after which an earlier decision no longer rests on the current facts.
export function changesFacts(e: IncidentEvent): boolean {
  return (
    e.type === "answer" ||
    e.type === "severity_confirmed" ||
    e.type === "awareness" ||
    (e.type === "extraction" && e.factKeys.length > 0)
  );
}

// Id of the last fact-changing event (0 if none): stable across events that do not touch facts,
// unlike snapshot.version, which every event (including the decision itself) bumps.
const factsEpoch = (events: LoggedEvent[]) => events.filter((e) => changesFacts(e.event)).at(-1)?.id ?? 0;

export function idempotencyKey(input: DecideInput, epoch: number): string {
  const { incidentId, obligationId, choice, reasons, by } = input;
  // ponytail: an identical decision (same choice, reasons, signer) re-signed on unchanged facts after a flip is deduped.
  const h = createHash("sha256").update(JSON.stringify([incidentId, obligationId, choice, reasons.trim(), epoch, by.name]));
  return `decision:${h.digest("hex")}`;
}

function check(input: DecideInput, snapshot: IncidentSnapshot) {
  if (!SIGNER_ROLES.includes(input.by.role))
    throw new DecisionRefused(`Only ${SIGNER_ROLES.join(", ")} may sign a decision (got "${input.by.role}").`);
  if (input.reasons.trim().length < MIN_REASONS_LENGTH)
    throw new DecisionRefused(`Reasons must be written out (at least ${MIN_REASONS_LENGTH} characters): Art. 33(5) requires documenting them.`);
  const obligation = evaluate(snapshot).obligations.find((o) => o.id === input.obligationId);
  if (!obligation) throw new DecisionRefused(`Unknown obligation ${input.obligationId}.`);
  const firmlyRequired = obligation.status === "required" && obligation.factsToConfirm.length === 0;
  if (input.choice === "do_not_notify" && firmlyRequired && !input.overrideRecommendation)
    throw new DecisionRefused(
      "The computed status is \"required\" on confirmed facts: set overrideRecommendation to decide not to notify.",
    );
  return firmlyRequired && input.choice === "do_not_notify";
}

export async function decide(input: DecideInput): Promise<{ event: DecisionEvent; version: number; idempotencyKey: string; replayed: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const [snapshot, events] = await Promise.all([loadSnapshot(input.incidentId), listEvents(input.incidentId)]);
    const overridden = check(input, snapshot); // re-checked after a reload: facts may have changed
    const event: DecisionEvent = {
      type: "decision",
      by: input.by,
      obligationId: input.obligationId,
      choice: input.choice,
      // The event schema has no override field: the override is written into the reasons so the register shows it.
      reasons: input.reasons.trim() + (overridden ? '\n\n[Recommendation overridden: computed status was "required".]' : ""),
      factsVersion: snapshot.version,
      moduleVersion: GDPR_MODULE_VERSION,
    };
    const key = idempotencyKey(input, factsEpoch(events));
    try {
      const version = await recordEvent({
        incidentId: input.incidentId,
        expectedVersion: snapshot.version,
        actor: input.by.name,
        event,
        idempotencyKey: key,
      });
      // record_event returns the version unchanged when the key was already recorded: return what is stored.
      if (version === snapshot.version) {
        const stored = (await listEvents(input.incidentId))
          .map((e) => e.event)
          .findLast((e): e is DecisionEvent => e.type === "decision" && e.obligationId === input.obligationId);
        return { event: stored ?? event, version, idempotencyKey: key, replayed: true };
      }
      return { event, version, idempotencyKey: key, replayed: false };
    } catch (e) {
      if (e instanceof VersionConflict && attempt === 0) continue;
      throw e;
    }
  }
}

export type DecisionStatus = {
  obligationId: string;
  decision: DecisionEvent;
  eventId: number;
  at: string;
  status: "current" | "to_re_evaluate";
};

// Latest decision per obligation; stale when a fact-changing event was recorded after it. Pure.
export function decisionStatus(events: LoggedEvent[]): DecisionStatus[] {
  const latest = new Map<string, DecisionStatus>();
  for (const { id, at, event } of events) {
    if (event.type === "decision")
      latest.set(event.obligationId, { obligationId: event.obligationId, decision: event, eventId: id, at, status: "current" });
    else if (changesFacts(event)) for (const d of latest.values()) d.status = "to_re_evaluate";
  }
  return [...latest.values()];
}
