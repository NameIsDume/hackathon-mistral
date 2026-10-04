// Role-based Slack DMs (#25). Each role's DM is built strictly from what ROLE_MATRIX lets that role see.
import { z } from "zod";
import { Severity, type Assessment, type Fact, type IncidentEvent, type IncidentSnapshot, type Role } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS, GDPR_QUESTIONS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { db, listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { briefBlocks, button, openDm, option, plain, postDm, questionBlocks, section, type Block } from "@/lib/adapters/slack";
import { DECIDABLE_OBLIGATIONS, decisionStatus, SIGNERS, type DecisionStatus, type Stage } from "@/lib/services/decide";
import { deadline, formatParis, type Clock } from "@/lib/clocks";

type Kind = Extract<IncidentEvent, { type: "notification" }>["kind"];

// ===========================================================================
// ROLE MATRIX — proposal, pending the lead lawyer's validation (Notion, issue #25).
// Change what a role sees here, and only here.
// ===========================================================================
type RoleRule = {
  kind: Kind;
  ack: boolean; // acknowledgement + what to do now
  brief: boolean; // the incident summary
  facts: boolean; // every fact with its sources
  assessment: "full" | "statuses" | false; // obligations with reasons and legal refs, or one-line statuses
  clock: boolean; // 72h authority clock
  questions: boolean; // facts owned by this role (GDPR_FACTS[k].role): blocking or disputed ones to answer, AI-proposed ones to confirm
  review: boolean; // severity and awareness time controls
  // Recommendation / decision controls follow SIGNERS (lib/services/decide.ts): the DPO recommends, the lawyer decides.
};
const NONE = { ack: false, brief: false, facts: false, assessment: false, clock: false, questions: false, review: false } as const;

export const ROLE_MATRIX: Record<Role, RoleRule | null> = {
  reporter: { ...NONE, kind: "brief", ack: true }, // Q12: "report received" only, never the outcome
  it: { ...NONE, kind: "questions", brief: true, questions: true },
  business_owner: { ...NONE, kind: "questions", brief: true, questions: true },
  dpo: { ...NONE, kind: "assessment", brief: true, facts: true, assessment: "full", clock: true, questions: true, review: true },
  lawyer: { ...NONE, kind: "assessment", brief: true, facts: true, assessment: "full", clock: true }, // + the case to decide (Q14)
  management: { ...NONE, kind: "management_note", brief: true, assessment: "statuses", clock: true },
  communications: null, // nothing in the MVP
};

// Who is notified, by severity. Unknown severity uses the "average" wave (lawyer included).
export const WAVES: Record<Severity, Role[]> = {
  false_positive: ["reporter", "it"],
  minimal: ["it", "dpo"],
  average: ["it", "dpo", "lawyer", "business_owner"],
  major: ["it", "dpo", "lawyer", "business_owner", "management"],
};
export const waveFor = (severity: Severity | null): Role[] => WAVES[severity ?? "average"];

// ===========================================================================

export const OBLIGATION_LABEL: Record<string, string> = {
  "gdpr.record_breach": "Record the breach in the internal register",
  "gdpr.notify_controller": "Inform the client (we act as processor)",
  "gdpr.notify_authority": "Notify the data protection authority (CNIL)",
  "gdpr.inform_subjects": "Inform the people concerned",
};
const SHORT_LABEL: Record<(typeof DECIDABLE_OBLIGATIONS)[number], string> = {
  "gdpr.notify_authority": "CNIL",
  "gdpr.inform_subjects": "people concerned",
  "gdpr.notify_controller": "client",
};
const PHASED_WITHIN_MS = 12 * 3_600_000; // Q7: propose a phased notification this close to the 72 h deadline

// Q13/Q14: how sure we are of a fact. Disputed and null count as unknown, like the rules.
export function factState(f: Fact<unknown>): string {
  const state =
    f.state === "disputed"
      ? "marked wrong, counts as unknown"
      : f.value === null
        ? "unknown"
        : f.state === "confirmed"
          ? `confirmed${f.confirmedBy ? ` by ${f.confirmedBy}` : ""}`
          : "proposed by the AI, not confirmed";
  return state + (f.dontKnowBy ? `; "I don't know" from ${f.dontKnowBy}` : "");
}

// "3 h 20 min left" / "overdue by 2 h 5 min".
export function formatLeft(ms: number): string {
  const m = Math.floor(Math.abs(ms) / 60_000);
  const t = `${Math.floor(m / 60)} h ${m % 60} min`;
  return ms < 0 ? `overdue by ${t}` : `${t} left`;
}

const describeDecision = (d: DecisionStatus) =>
  `• ${OBLIGATION_LABEL[d.obligationId] ?? d.obligationId}: *${d.decision.choice.replaceAll("_", " ")}*, by ${d.decision.by.name}` +
  (d.status === "to_re_evaluate" ? " (*to re-evaluate*: facts changed since)" : "") +
  (d.decision.flag ? `\n  _${d.decision.flag}_` : "") +
  (d.stage === "recommendation" ? `\n  > ${d.decision.reasons.slice(0, 500).replaceAll("\n", "\n  > ")}` : "");

export const showValue = (v: unknown) =>
  v === null || v === undefined ? "unknown" : typeof v === "boolean" ? (v ? "Yes" : "No") : Array.isArray(v) ? v.join(", ") : String(v);

export const isBooleanFact = (key: string) => key in GDPR_FACTS && GDPR_FACTS[key as GdprFactKey].value instanceof z.ZodBoolean;

export type Dm = { kind: Kind; blocks: Block[]; text: string; questionIds: string[] };
// reask: fact keys the lawyer asked to check again (asked even when already answered).
type Ctx = { snapshot: IncidentSnapshot; assessment: Assessment; brief: string | null; now: Date; decisions?: DecisionStatus[]; reask?: string[] };

// Pure: the DM a role receives, or null when the role receives nothing.
export function buildDm(role: Role, { snapshot, assessment, brief, now, decisions = [], reask = [] }: Ctx): Dm | null {
  const rule = ROLE_MATRIX[role];
  if (!rule) return null;
  const stage = (Object.keys(SIGNERS) as Stage[]).find((s) => SIGNERS[s] === role);
  const authority = assessment.obligations.find((o) => o.id === "gdpr.notify_authority");
  const clock = authority?.deadline && deadline(authority.deadline, snapshot, now);
  const blocks: Block[] = [];
  const lines: string[] = [];
  const para = (t: string) => {
    blocks.push(section(t));
    lines.push(t);
  };

  if (rule.ack)
    para(
      "Thank you, your report was received and the incident response team is on it.\n*What to do now:* do not delete anything (emails, files, logs), do not try to fix it yourself, stay reachable for IT, and do not discuss the incident outside the response team.",
    );
  if (rule.brief) para(`*Summary:* ${brief ?? "summary not available yet."}`);
  if (rule.facts) {
    const rows = Object.entries(snapshot.facts).map(([k, f]) => {
      const src = f.sources.map((s) => `"${s.excerpt}"`).join("; ");
      return `• ${k}: ${showValue(f.value)} — ${factState(f)}${src ? ` — ${src}` : ""}`;
    });
    para(`*Facts*\n${rows.join("\n") || "none yet"}`);
  }
  if (rule.assessment === "full")
    for (const o of assessment.obligations)
      para(
        `*${OBLIGATION_LABEL[o.id] ?? o.id}*: ${o.status} (${o.legalRefs.join(", ")})\n${o.reasons.join("\n")}` +
          (o.factsToConfirm.length ? `\nFacts to confirm: ${o.factsToConfirm.join(", ")}` : ""),
      );
  if (rule.assessment === "statuses")
    para(assessment.obligations.map((o) => `• ${OBLIGATION_LABEL[o.id] ?? o.id}: ${o.status.replace("_", " ")}`).join("\n"));
  if (rule.clock && clock?.dueAt)
    para(
      `*72h authority deadline:* ${formatParis(clock.dueAt)}${clock.provisional ? " (provisional: counted from the first signal until awareness is confirmed)" : ""}` +
        (stage ? "\n*Informing the people concerned:* without undue delay once a high risk is established (Art. 34)." : ""),
    );

  if (rule.review) {
    const id = snapshot.id;
    const s = snapshot.severity;
    const sev = `*Severity:* ${s.value ?? "unknown"} (${s.state === "confirmed" ? `confirmed by ${s.confirmedBy ?? "a reviewer"}` : "proposed by the AI, to confirm"})`;
    blocks.push({
      ...section(sev),
      accessory: {
        type: "static_select",
        action_id: "severity",
        placeholder: plain("Confirm or correct"),
        options: Severity.options.map((v) => option(JSON.stringify({ incidentId: id, severity: v }), v.replace("_", " "))),
      },
    });
    lines.push(sev);
    para(
      `*Awareness time:* ${snapshot.awarenessAt ? formatParis(snapshot.awarenessAt) : "not set (the 72h clock is provisional, counted from the first signal)"}\nPick when we became aware (your Slack time zone):`,
    );
    blocks.push({
      type: "actions",
      block_id: `awareness:${id}`,
      elements: [
        {
          type: "datetimepicker",
          action_id: "awareness",
          ...(snapshot.awarenessAt && { initial_date_time: Math.floor(Date.parse(snapshot.awarenessAt) / 1000) }),
        },
      ],
    });
  }
  if (stage) signingBlocks(stage, { snapshot, assessment, decisions, clock }, para, blocks);

  // Facts this role holds: AI proposals to confirm, blocking or disputed facts to answer.
  const blocking = new Set(assessment.obligations.flatMap((o) => o.blockingQuestions));
  const questions = rule.questions
    ? GDPR_QUESTIONS.filter((q) => {
        const f = snapshot.facts[q.factKey];
        if (q.role !== role) return false;
        if (reask.includes(q.factKey)) return true;
        // Confirmed by a human, or answered "I don't know" (Q13), is never asked again unless the lawyer asks for it.
        if (f?.state === "confirmed" || f?.dontKnowBy) return false;
        return blocking.has(q.factKey) || f?.state === "disputed" || (f?.state === "proposed" && f.value !== null);
      })
    : [];
  if (questions.length) para(`*${questions.length === 1 ? "One question" : `${questions.length} questions`} for you*`);
  for (const q of questions) {
    const f = snapshot.facts[q.factKey];
    const value = (v: object) => JSON.stringify({ incidentId: snapshot.id, factKey: q.factKey, ...v });
    lines.push(q.text);
    const dontKnow = button("I don't know", "fact_dont_know", value({}));
    if (reask.includes(q.factKey)) blocks.push(section(`_The lawyer asks you to check this again (currently: ${showValue(f?.value)})._`));
    if (f?.state === "proposed" && f.value !== null) {
      const src = f.sources.map((s) => s.excerpt).filter(Boolean).join(" … ");
      blocks.push(section(`*${q.text}*\nThe AI suggests: *${showValue(f.value)}*${src ? `\n> ${src.slice(0, 500)}` : ""}`), {
        type: "actions",
        block_id: q.factKey,
        elements: [button("Confirm", "fact_confirm", value({}), "primary"), button("Wrong", "fact_wrong", value({}), "danger"), dontKnow],
      });
    } else if (isBooleanFact(q.factKey)) blocks.push(...questionBlocks(snapshot.id, q.factKey, q.text));
    else
      blocks.push(section(`*${q.text}*${f?.state === "disputed" ? `\n_The suggested value (${showValue(f.value)}) was marked wrong._` : ""}`), {
        type: "actions",
        block_id: q.factKey,
        elements: [button("Answer", "fact_input", value({})), dontKnow],
      });
  }

  if (!lines.length) return null;
  const title = { reporter: "Report received", management: "Incident note for management" }[role as string] ?? "Incident update";
  return { kind: rule.kind, blocks: [...briefBlocks(title, []), ...blocks], text: lines.join("\n\n"), questionIds: questions.map((q) => q.id) };
}

// Q9/Q14: the DPO's recommendation controls, or the lawyer's case to decide. Q7: phased notification near the deadline.
function signingBlocks(
  stage: Stage,
  { snapshot, assessment, decisions, clock }: { snapshot: IncidentSnapshot; assessment: Assessment; decisions: DecisionStatus[]; clock?: Clock },
  para: (t: string) => void,
  blocks: Block[],
) {
  const id = snapshot.id;
  const latest = (o: string, s: Stage) => decisions.find((d) => d.obligationId === o && d.stage === s);
  const settled = (o: string) => {
    const d = latest(o, "decision");
    return d?.status === "current" && d.decision.choice !== "defer";
  };
  const statusOf = (o: string) => assessment.obligations.find((x) => x.id === o)?.status;

  if (stage === "decision") {
    const open = [...new Set(assessment.obligations.flatMap((o) => o.blockingQuestions))];
    para(`*Open questions*\n${open.map((k) => `• ${k} (asked to ${GDPR_FACTS[k as GdprFactKey]?.role.replace("_", " ") ?? "?"})`).join("\n") || "none"}`);
  }
  const listed = (s: Stage) => decisions.filter((d) => d.stage === s).map(describeDecision).join("\n");
  para(`*DPO recommendations*\n${listed("recommendation") || "none yet"}\n*Lawyer decisions*\n${listed("decision") || "none signed yet"}`);

  const authority = statusOf("gdpr.notify_authority");
  // Rules 1.0.0 treat unknown as yes, so "undetermined" mostly shows as "required, facts to confirm": same Art. 33(4) case.
  const pending = authority === "undetermined" || (authority === "required" && !!assessment.obligations.find((x) => x.id === "gdpr.notify_authority")?.factsToConfirm.length);
  const deferred = (latest("gdpr.notify_authority", "decision") ?? latest("gdpr.notify_authority", "recommendation"))?.decision.choice === "defer";
  if (clock?.dueAt && clock.remainingMs <= PHASED_WITHIN_MS && !settled("gdpr.notify_authority") && (pending || deferred))
    para(
      `*Propose a phased notification (Art. 33(4)):* the CNIL deadline (${formatParis(clock.dueAt)}) is less than 12 h away and the decision is still ${deferred ? "deferred" : "pending facts to confirm"}. Notify now with what is known and complete it as facts come in.`,
    );

  if (stage === "decision") {
    // Every decidable obligation not yet signed for good, unless it is "not required" and nobody recommended anything.
    const needed = DECIDABLE_OBLIGATIONS.filter((o) => !settled(o) && (statusOf(o) !== "not_required" || latest(o, "recommendation")));
    para(needed.length ? `*Your decision is needed:* ${needed.map((o) => OBLIGATION_LABEL[o]).join("; ")}.` : "*No decision pending.*");
  }
  const elements = DECIDABLE_OBLIGATIONS.map((o) =>
    button(`${stage === "decision" ? "Decide" : "Recommend"}: ${SHORT_LABEL[o]}`, `sign_decision:${o}`, JSON.stringify({ incidentId: id, obligationId: o, stage })),
  );
  if (stage === "decision")
    elements.push(
      button("Ask a follow-up question", "lawyer_ask", JSON.stringify({ incidentId: id })),
      button("Request more facts", "lawyer_request_facts", JSON.stringify({ incidentId: id })),
    );
  blocks.push({ type: "actions", block_id: "sign", elements });
}

// ---------------------------------------------------------------------------

type PersonRow = { id: string; name: string; role: Role; slack_user_id: string | null };
type EventRow = { type: string; payload: { brief?: string | null; preview?: string; delivered?: boolean }; idempotency_key: string | null };

// Records an event at the current version; on a version conflict, reloads and retries once.
export async function recordWithRetry(incidentId: string, version: number, args: Omit<Parameters<typeof recordEvent>[0], "incidentId" | "expectedVersion">) {
  try {
    return await recordEvent({ ...args, incidentId, expectedVersion: version });
  } catch (e) {
    if (!(e instanceof VersionConflict)) throw e;
    const fresh = await loadSnapshot(incidentId);
    return recordEvent({ ...args, incidentId, expectedVersion: fresh.version });
  }
}

// `roles` restricts the wave (#40: only the newly concerned roles after a severity change); default = the whole wave.
// `reask` (Q14 "Request more facts"): facts asked again even if answered; `actor` and `key` trace who asked.
export async function notifyWave(incidentId: string, now = new Date(), roles?: Role[], opts: { reask?: string[]; actor?: string; key?: string } = {}) {
  const snapshot = await loadSnapshot(incidentId);
  const assessment = evaluate(snapshot);
  roles ??= waveFor(snapshot.severity.value);
  const [people, events, logged] = await Promise.all([
    db().from("people").select("id, name, role, slack_user_id").in("role", roles),
    db().from("incident_events").select("type, payload, idempotency_key").eq("incident_id", incidentId).order("id"),
    listEvents(incidentId),
  ]);
  const decisions = decisionStatus(logged);
  if (people.error) throw new Error(people.error.message);
  if (events.error) throw new Error(events.error.message);
  const rows = events.data as EventRow[];
  const brief = rows.findLast((r) => r.type === "extraction" && r.payload.brief)?.payload.brief ?? null;

  let version = snapshot.version;
  const results: { person: string; role: Role; delivered: boolean; error?: string; skipped?: true }[] = [];
  for (const p of people.data as PersonRow[]) {
    const dm = buildDm(p.role, { snapshot, assessment, brief, now, decisions, reask: opts.reask });
    if (!dm) continue;
    const prefix = `notify:${incidentId}:${p.id}:${dm.kind}:`;
    // ponytail: content-based dedupe (same DM already delivered -> skip), since every event bumps the version.
    if (rows.some((r) => r.idempotency_key?.startsWith(prefix) && r.payload.delivered && r.payload.preview === dm.text)) {
      results.push({ person: p.name, role: p.role, delivered: true, skipped: true });
      continue;
    }
    let slack: { channel: string; ts: string } | null = null;
    let error: string | undefined;
    try {
      if (!p.slack_user_id) throw new Error("no slack_user_id for this person");
      slack = await postDm(await openDm(p.slack_user_id), dm.blocks, dm.text);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    version = await recordWithRetry(incidentId, version, {
      actor: opts.actor ?? "notify",
      idempotencyKey: prefix + snapshot.version + (opts.key ? `:${opts.key}` : ""),
      event: {
        type: "notification",
        to: { role: p.role, name: p.name, ...(p.slack_user_id && { slackUserId: p.slack_user_id }) },
        kind: dm.kind,
        questionIds: dm.questionIds,
        preview: dm.text,
        slack,
        delivered: !!slack,
        ...(error && { error }),
      },
    });
    results.push({ person: p.name, role: p.role, delivered: !!slack, ...(error && { error }) });
  }
  return results;
}
