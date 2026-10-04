// Two-step human sign-off on one GDPR obligation (Q9, legal decisions 2026-10-04): the DPO records a recommendation,
// the lawyer signs the decision. The computed status never decides. Reasons are structured (Q10, Art. 33(5)).
// History is never rewritten; a recommendation or decision made before facts changed is shown "to re-evaluate".
import { createHash } from "node:crypto";
import type { IncidentEvent, IncidentSnapshot, Obligation, Role } from "@/lib/domain";
import { listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { evaluate, GDPR_MODULE_VERSION } from "@/lib/regulations/gdpr";
import { GDPR_FACTS } from "@/lib/regulations/gdpr/facts";
import { deadline } from "@/lib/clocks";

export type Stage = "recommendation" | "decision";
// Q9: who records each stage. One person may hold both roles in a small organisation; the record keeps them apart.
export const SIGNERS = { recommendation: "dpo", decision: "lawyer" } as const satisfies Record<Stage, Role>;
export const DECIDABLE_OBLIGATIONS = ["gdpr.notify_authority", "gdpr.inform_subjects", "gdpr.notify_controller"] as const;

export type DecisionEvent = Extract<IncidentEvent, { type: "decision" }>;
export type Choice = DecisionEvent["choice"];
export type Reasons = NonNullable<DecisionEvent["structured"]>;
export type LoggedEvent = { id: number; at: string; event: IncidentEvent };

export const stageOf = (e: DecisionEvent): Stage => e.stage ?? "decision";

// `field` names the reasons field (= Slack modal block) the refusal is about.
export class DecisionRefused extends Error {
  constructor(
    message: string,
    readonly field: keyof Reasons | "choice" | "override" = "freeText",
  ) {
    super(message);
  }
}

export type DecideInput = {
  incidentId: string;
  obligationId: (typeof DECIDABLE_OBLIGATIONS)[number];
  stage: Stage;
  choice: Choice;
  reasons: Reasons;
  by: { role: Role; name: string };
  overrideRecommendation?: boolean;
  now?: Date;
};

// Q7: not notifying needs an explicit override unless the result is "not required" on confirmed facts.
// controller_duty / controller_decides (#47, we are processor) mean "not ours to do". Any other status, known or not, needs it.
const NOT_OURS: readonly string[] = ["not_required", "controller_duty", "controller_decides"];
export const needsOverride = (o: Obligation | undefined) => !o || !NOT_OURS.includes(o.status) || o.factsToConfirm.length > 0;

// Q8: notifying against "not required" is flagged, never blocked. Stronger for the people concerned.
export function flagFor(o: Obligation | undefined, choice: Choice): string | undefined {
  if (choice !== "notify" || o?.status !== "not_required") return undefined;
  return o.id === "gdpr.inform_subjects"
    ? 'Strong flag: informing the people concerned although the computed status is "not required".'
    : 'Flag: notifying although the computed status is "not required".';
}

export function authorityOverdue(snapshot: IncidentSnapshot, obligations: Obligation[], now: Date): boolean {
  const d = obligations.find((o) => o.id === "gdpr.notify_authority")?.deadline;
  const c = d && deadline(d, snapshot, now);
  return !!c && "overdue" in c && c.overdue;
}

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

const clean = (r: Reasons): Reasons => {
  const out: Reasons = { factsReliedOn: [...new Set(r.factsReliedOn)], riskFactors: r.riskFactors.trim() };
  for (const k of ["exceptionRelied", "evidence", "delayReason", "freeText"] as const) if (r[k]?.trim()) out[k] = r[k]!.trim();
  return out;
};

export function idempotencyKey(input: DecideInput, epoch: number): string {
  const { incidentId, obligationId, stage, choice, reasons, by } = input;
  // ponytail: an identical decision (same choice, reasons, signer) re-signed on unchanged facts after a flip is deduped.
  const h = createHash("sha256").update(JSON.stringify([incidentId, obligationId, stage, choice, clean(reasons), epoch, by.name]));
  return `decision:${h.digest("hex")}`;
}

// Q10: what each choice must document. Throws DecisionRefused naming the missing field.
export function checkReasons(choice: Choice, r: Reasons, { flagged = false, overdue = false } = {}) {
  const blank = (s?: string) => !s?.trim();
  const unknown = r.factsReliedOn.filter((k) => !(k in GDPR_FACTS));
  if (unknown.length) throw new DecisionRefused(`Unknown facts: ${unknown.join(", ")}.`, "factsReliedOn");
  if (choice === "defer") {
    if (blank(r.freeText)) throw new DecisionRefused("Say which facts you are waiting for.", "freeText");
  } else {
    if (!r.factsReliedOn.length) throw new DecisionRefused("Pick the facts that matter most.", "factsReliedOn");
    if (blank(r.riskFactors)) throw new DecisionRefused("Say what could go wrong for the people affected.", "riskFactors");
  }
  if (choice === "do_not_notify") {
    if (blank(r.exceptionRelied)) throw new DecisionRefused("Say why it is safe not to go ahead (for example: the files were encrypted and the key is safe).", "exceptionRelied");
    if (blank(r.evidence)) throw new DecisionRefused("Say how we know it is safe (for example: IT checked the encryption).", "evidence");
  }
  if ((choice === "do_not_notify" || flagged) && blank(r.freeText)) throw new DecisionRefused("Explain your choice in a few words.", "freeText");
  if (overdue && blank(r.delayReason)) throw new DecisionRefused("The 72-hour deadline has passed: say why this is late.", "delayReason");
}

function check(input: DecideInput, snapshot: IncidentSnapshot) {
  const signer = SIGNERS[input.stage];
  if (input.by.role !== signer)
    throw new DecisionRefused(`Only the ${signer} may ${input.stage === "decision" ? "sign the decision" : "record the recommendation"} (got "${input.by.role}").`, "choice");
  const { obligations } = evaluate(snapshot);
  const o = obligations.find((x) => x.id === input.obligationId);
  if (!o) throw new DecisionRefused(`Unknown obligation ${input.obligationId}.`, "choice");
  const override = input.choice === "do_not_notify" && needsOverride(o);
  if (override && !input.overrideRecommendation)
    throw new DecisionRefused(
      "The app does not say this is safe to skip. To say no anyway, tick \"Going against the app\".",
      "override",
    );
  const flag = flagFor(o, input.choice);
  checkReasons(input.choice, input.reasons, { flagged: !!flag, overdue: authorityOverdue(snapshot, obligations, input.now ?? new Date()) });
  return { override, flag };
}

function render(r: Reasons, override: boolean, flag?: string): string {
  return [
    r.factsReliedOn.length && `Facts relied on: ${r.factsReliedOn.join(", ")}.`,
    r.riskFactors && `Risk factors: ${r.riskFactors}`,
    r.exceptionRelied && `Exception relied on: ${r.exceptionRelied}`,
    r.evidence && `Evidence: ${r.evidence}`,
    r.delayReason && `Reasons for the delay: ${r.delayReason}`,
    r.freeText,
    override && '[Override: the computed status was not "not required on confirmed facts".]',
    flag && `[${flag}]`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function decide(input: DecideInput): Promise<{ event: DecisionEvent; version: number; idempotencyKey: string; replayed: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const [snapshot, events] = await Promise.all([loadSnapshot(input.incidentId), listEvents(input.incidentId)]);
    const { override, flag } = check(input, snapshot); // re-checked after a reload: facts may have changed
    const structured = clean(input.reasons);
    const event: DecisionEvent = {
      type: "decision",
      stage: input.stage,
      by: input.by,
      obligationId: input.obligationId,
      choice: input.choice,
      reasons: render(structured, override, flag),
      structured,
      ...(override && { override }),
      ...(flag && { flag }),
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
          .findLast((e): e is DecisionEvent => e.type === "decision" && e.obligationId === input.obligationId && stageOf(e) === input.stage);
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
  stage: Stage;
  decision: DecisionEvent;
  eventId: number;
  at: string;
  status: "current" | "to_re_evaluate";
};

// Latest recommendation and latest decision per obligation; stale when a fact-changing event was recorded after it. Pure.
export function decisionStatus(events: LoggedEvent[]): DecisionStatus[] {
  const latest = new Map<string, DecisionStatus>();
  for (const { id, at, event } of events) {
    if (event.type === "decision") {
      const stage = stageOf(event);
      latest.set(`${event.obligationId}:${stage}`, { obligationId: event.obligationId, stage, decision: event, eventId: id, at, status: "current" });
    } else if (changesFacts(event)) for (const d of latest.values()) d.status = "to_re_evaluate";
  }
  return [...latest.values()];
}
