// Role-based Slack DMs (#25). Each role's DM is built strictly from what ROLE_MATRIX lets that role see.
import { z } from "zod";
import { Severity, type Assessment, type Fact, type IncidentEvent, type IncidentSnapshot, type Role } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS, GDPR_QUESTIONS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { db, listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { button, context, divider, fields, header, openDm, option, plain, postDm, questionBlocks, section, type Block } from "@/lib/adapters/slack";
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

// The live report on the read-only site (one per incident). Vercel exposes the production domain at runtime.
const SITE = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "hackathon-mistral.vercel.app"}`;
export const reportUrl = (incidentId: string) => `${SITE}/incidents/${incidentId}`;

// Plain words for what the lawyer and the DPO read (Martyna: no technical terms for the person who signs).
export const PLAIN: Record<(typeof DECIDABLE_OBLIGATIONS)[number], { question: string; yes: string; no: string }> = {
  "gdpr.notify_authority": { question: "Should we report this to the CNIL?", yes: "Yes, report it", no: "No, don't report it" },
  "gdpr.inform_subjects": { question: "Should we tell the people affected?", yes: "Yes, tell them", no: "No, don't tell them" },
  "gdpr.notify_controller": { question: "Should we tell our client?", yes: "Yes, tell the client", no: "No, don't tell the client" },
};
export const PLAIN_STATUS: Record<string, string> = {
  required: "yes, this needs to be done",
  not_required: "not needed, based on confirmed facts",
  undetermined: "your call: the facts don't settle it",
  controller_duty: "this is the client's job",
  controller_decides: "the client decides",
};
export const PLAIN_CHOICE: Record<string, string> = { notify: "go ahead", do_not_notify: "don't go ahead", defer: "wait for more facts" };
// The rules cite their sources ("Q5:", "(para 119)"); the person signing does not need them.
export const plainReason = (r: string) => {
  const t = r.replace(/^Q\d+:\s*/, "").replace(/\s*\((?:para|paras|Art\.)[^)]*\)/g, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
// Obligations someone here signs. As processor (#47) the CNIL and the people concerned are the client's call, and as
// controller there is no client to inform: no button, no "decision needed" for those.
const ours = (assessment: Assessment) =>
  DECIDABLE_OBLIGATIONS.filter((o) => {
    const status = assessment.obligations.find((x) => x.id === o)?.status;
    return status !== "controller_duty" && status !== "controller_decides" && !(o === "gdpr.notify_controller" && status === "not_required");
  });
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

// blocks: the sober DM (#57). text: the full plain record (notification fallback, `preview` in the event log, dedupe).
// details: the paragraphs behind "View details" (dm_details), only what this role may see.
export type Dm = { kind: Kind; blocks: Block[]; text: string; details: string[]; questionIds: string[] };
// reask: fact keys the lawyer asked to check again (asked even when already answered).
export type DmContext = { snapshot: IncidentSnapshot; assessment: Assessment; brief: string | null; now: Date; decisions?: DecisionStatus[]; reask?: string[] };

const ROLE_LABEL: Record<Role, string> = {
  reporter: "Reporter",
  it: "IT",
  business_owner: "Business owner",
  dpo: "DPO",
  lawyer: "Lawyer",
  management: "Management",
  communications: "Communications",
};
// One-line obligation names for the DM; OBLIGATION_LABEL stays the full wording (details, modals, drafts).
const OBLIGATION_SHORT: Record<string, string> = {
  "gdpr.record_breach": "Internal register",
  "gdpr.notify_controller": "Client notification",
  "gdpr.notify_authority": "CNIL notification",
  "gdpr.inform_subjects": "Informing the people concerned",
};
export const factLabel = (key: string) => GDPR_FACTS[key as GdprFactKey]?.label ?? key.charAt(0).toUpperCase() + key.slice(1).replaceAll("_", " ");
const shortState = (f: Fact<unknown>) =>
  (f.state === "disputed" ? "marked wrong" : f.value === null ? "unknown" : f.state === "confirmed" ? "confirmed" : "to confirm") + (f.dontKnowBy ? ", I don't know" : "");
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
// "Phishing on the CRM: 3 exports downloaded." -> "Phishing on the CRM".
const shortTitle = (brief: string | null) => {
  const t = brief?.split(/[:.\n]/)[0].trim();
  return t ? clip(t, 60) : null;
};

// Pure: the DM a role receives, or null when the role receives nothing.
// Layout (#57, same order for every role): header, context line, summary, facts (two columns), obligations, divider,
// controls (review, questions, signing). Reasons, legal refs and sources live behind "View details".
export function buildDm(role: Role, { snapshot, assessment, brief, now, decisions = [], reask = [] }: DmContext): Dm | null {
  const rule = ROLE_MATRIX[role];
  if (!rule) return null;
  const id = snapshot.id;
  const stage = (Object.keys(SIGNERS) as Stage[]).find((s) => SIGNERS[s] === role);
  const authority = assessment.obligations.find((o) => o.id === "gdpr.notify_authority");
  const clock = authority?.deadline && deadline(authority.deadline, snapshot, now);
  const lines: string[] = []; // the full record
  const details: string[] = [];
  const info: Block[] = [];
  const controls: Block[] = [];
  const detail = (t: string) => {
    lines.push(t);
    details.push(t);
  };

  if (rule.ack) {
    const ack =
      "Thank you, your report was received and the incident response team is on it.\n*What to do now:* do not delete anything (emails, files, logs), do not try to fix it yourself, stay reachable for IT, and do not discuss the incident outside the response team.";
    lines.push(ack);
    info.push(section(ack));
  }
  if (rule.brief) {
    lines.push(`*Summary:* ${brief ?? "summary not available yet."}`);
    info.push(section(brief ? clip(brief, 280) : "_Summary not available yet._"));
  }
  if (rule.facts) {
    const entries = Object.entries(snapshot.facts);
    const rows = entries.map(([k, f]) => {
      const src = f.sources.map((s) => `"${s.excerpt}"`).join("; ");
      return `• ${k}: ${showValue(f.value)} — ${factState(f)}${src ? ` — ${src}` : ""}`;
    });
    detail(`*Facts*\n${rows.join("\n") || "none yet"}`);
    const cells = entries.map(([k, f]) => `*${factLabel(k)}*\n${clip(showValue(f.value), 80)} · ${shortState(f)}`);
    const shown = cells.length > 10 ? [...cells.slice(0, 9), `*${cells.length - 9} more facts*\nin the details`] : cells;
    const view = button("View details", "dm_details", JSON.stringify({ incidentId: id, role }));
    info.push(shown.length ? fields(shown, view) : { ...section("_No facts yet._"), accessory: view });
  }

  // Obligations: one line each in the DM; reasons and legal refs in the details.
  const latest = (o: string, s: Stage) => decisions.find((d) => d.obligationId === o && d.stage === s);
  const summary: string[] = [];
  const status = (o: Assessment["obligations"][number]) => `• ${OBLIGATION_SHORT[o.id] ?? o.id} — *${o.status.replaceAll("_", " ")}*`;
  if (rule.assessment === "full")
    for (const o of assessment.obligations) {
      detail(
        `*${OBLIGATION_LABEL[o.id] ?? o.id}*: ${o.status} (${o.legalRefs.join(", ")})\n${o.reasons.join("\n")}` +
          (o.factsToConfirm.length ? `\nFacts to confirm: ${o.factsToConfirm.join(", ")}` : ""),
      );
      const n = o.factsToConfirm.length;
      const signed = stage
        ? (["recommendation", "decision"] as const)
            .map((s) => latest(o.id, s))
            .filter((d) => d !== undefined)
            .map((d) => `${d.stage === "decision" ? "lawyer" : "DPO"}: ${d.decision.choice.replaceAll("_", " ")}${d.status === "to_re_evaluate" ? " (to re-evaluate)" : ""}`)
        : [];
      summary.push(`${status(o)}${n ? `, ${n} fact${n > 1 ? "s" : ""} to confirm` : ""}${signed.map((x) => ` · ${x}`).join("")}`);
    }
  if (rule.assessment === "statuses") {
    lines.push(assessment.obligations.map((o) => `• ${OBLIGATION_LABEL[o.id] ?? o.id}: ${o.status.replace("_", " ")}`).join("\n"));
    summary.push(...assessment.obligations.map(status));
  }
  if (rule.clock && clock?.dueAt)
    detail(
      `*72h authority deadline:* ${formatParis(clock.dueAt)}${clock.provisional ? " (provisional: counted from the first signal until awareness is confirmed)" : ""}` +
        (stage ? "\n*Informing the people concerned:* without undue delay once a high risk is established (Art. 34)." : ""),
    );
  if (stage) summary.push(...signing(stage, { assessment, decisions, clock }, detail));
  if (summary.length) info.push(section(summary.join("\n")));

  if (rule.review) {
    const s = snapshot.severity;
    lines.push(`*Severity:* ${s.value ?? "unknown"} (${s.state === "confirmed" ? `confirmed by ${s.confirmedBy ?? "a reviewer"}` : "proposed by the AI, to confirm"})`);
    lines.push(
      `*Awareness time:* ${snapshot.awarenessAt ? `${formatParis(snapshot.awarenessAt)} (set from the report; correct it if we only became aware later)` : "not set (the 72h clock is provisional, counted from the first signal)"}`,
    );
    controls.push(section("*Your review:* confirm the severity, and correct the awareness time if needed (your Slack time zone)."), {
      type: "actions",
      block_id: `awareness:${id}`, // read by the awareness action
      elements: [
        {
          type: "static_select",
          action_id: "severity",
          placeholder: plain("Confirm the severity"),
          options: Severity.options.map((v) => option(JSON.stringify({ incidentId: id, severity: v }), v.replace("_", " "))),
        },
        { type: "datetimepicker", action_id: "awareness", ...(snapshot.awarenessAt && { initial_date_time: Math.floor(Date.parse(snapshot.awarenessAt) / 1000) }) },
      ],
    });
  }

  // Facts this role holds: AI proposals to confirm, blocking or disputed facts to answer. One section + one button row each.
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
  if (questions.length) lines.push(`*${questions.length === 1 ? "One question" : `${questions.length} questions`} for you*`);
  else if (rule.questions && role !== "dpo") {
    // Nothing left to ask (answers given, "I don't know" is never re-asked): say so, and how to add or change something.
    const done = "*Nothing more needed from you for now.* Learned something new or want to change an answer? Just reply here in your own words.";
    lines.push(done);
    controls.push(section(done));
  }
  for (const q of questions) {
    const f = snapshot.facts[q.factKey];
    const value = (v: object) => JSON.stringify({ incidentId: id, factKey: q.factKey, ...v });
    lines.push(q.text);
    const dontKnow = button("I don't know", "fact_dont_know", value({}));
    const again = reask.includes(q.factKey) ? `\n_The lawyer asks you to check this again (currently: ${showValue(f?.value)})._` : "";
    if (f?.state === "proposed" && f.value !== null) {
      const src = f.sources.map((s) => s.excerpt).filter(Boolean).join(" … ");
      controls.push(section(`*${q.text}*${again}\nThe AI suggests: *${showValue(f.value)}*${src ? ` — _“${clip(src, 150)}”_` : ""}`), {
        type: "actions",
        block_id: q.factKey,
        elements: [button("Confirm", "fact_confirm", value({}), "primary"), button("Wrong", "fact_wrong", value({}), "danger"), dontKnow],
      });
    } else if (isBooleanFact(q.factKey)) controls.push(...questionBlocks(id, q.factKey, `*${q.text}*${again}`));
    else
      controls.push(section(`*${q.text}*${again}${f?.state === "disputed" ? `\n_The suggested value (${showValue(f.value)}) was marked wrong._` : ""}`), {
        type: "actions",
        block_id: q.factKey,
        elements: [button("Answer", "fact_input", value({})), dontKnow],
      });
  }
  if (stage) {
    const elements = ours(assessment).map((o) =>
      button(`${stage === "decision" ? "Decide" : "Recommend"}: ${SHORT_LABEL[o]}`, `sign_decision:${o}`, JSON.stringify({ incidentId: id, obligationId: o, stage })),
    );
    if (stage === "decision")
      elements.push(
        button("Ask a follow-up question", "lawyer_ask", JSON.stringify({ incidentId: id })),
        button("Request more facts", "lawyer_request_facts", JSON.stringify({ incidentId: id })),
      );
    controls.push({ type: "actions", block_id: "sign", elements });
  }

  if (!lines.length) return null;
  const sev = snapshot.severity;
  const top =
    role === "reporter"
      ? [header("Report received")]
      : [
          header(`Incident · ${shortTitle(rule.brief ? brief : null) ?? id.slice(0, 8)}`),
          context(
            rule.assessment !== false && `Severity: *${sev.value?.replace("_", " ") ?? "unknown"}* (${sev.state === "confirmed" ? "confirmed" : "proposed"})`,
            rule.clock && clock?.dueAt && `CNIL deadline: *${formatParis(clock.dueAt)}* Paris${clock.overdue ? ", *overdue*" : ""}${clock.provisional ? " (provisional)" : ""}`,
            `Your role: ${ROLE_LABEL[role]}`,
            `<${reportUrl(id)}|Live report>`,
          ),
        ];
  const blocks = [...top, ...info, ...(info.length && controls.length ? [divider] : []), ...controls];
  return { kind: rule.kind, blocks, text: lines.join("\n\n"), details, questionIds: questions.map((q) => q.id) };
}

// Q9/Q14: what the DPO and the lawyer sign. Q7: phased notification near the deadline.
// Full paragraphs go to the details; returns the short lines for the DM.
function signing(
  stage: Stage,
  { assessment, decisions, clock }: { assessment: Assessment; decisions: DecisionStatus[]; clock?: Clock },
  detail: (t: string) => void,
): string[] {
  const out: string[] = [];
  const latest = (o: string, s: Stage) => decisions.find((d) => d.obligationId === o && d.stage === s);
  const settled = (o: string) => {
    const d = latest(o, "decision");
    return d?.status === "current" && d.decision.choice !== "defer";
  };
  const statusOf = (o: string) => assessment.obligations.find((x) => x.id === o)?.status;

  if (stage === "decision") {
    const open = [...new Set(assessment.obligations.flatMap((o) => o.blockingQuestions))];
    const asked = (k: string) => GDPR_FACTS[k as GdprFactKey]?.role.replace("_", " ") ?? "?";
    detail(`*Open questions*\n${open.map((k) => `• ${k} (asked to ${asked(k)})`).join("\n") || "none"}`);
    const holder = (k: string) => (k in GDPR_FACTS ? ROLE_LABEL[GDPR_FACTS[k as GdprFactKey].role] : "?");
    if (open.length) out.push(`*Open questions:* ${open.map((k) => `${factLabel(k).toLowerCase()} (${holder(k)})`).join(", ")}`);
  }
  const listed = (s: Stage) => decisions.filter((d) => d.stage === s).map(describeDecision).join("\n");
  detail(`*DPO recommendations*\n${listed("recommendation") || "none yet"}\n*Lawyer decisions*\n${listed("decision") || "none signed yet"}`);

  const authority = statusOf("gdpr.notify_authority");
  // Rules 1.0.0 treat unknown as yes, so "undetermined" mostly shows as "required, facts to confirm": same Art. 33(4) case.
  const pending = authority === "undetermined" || (authority === "required" && !!assessment.obligations.find((x) => x.id === "gdpr.notify_authority")?.factsToConfirm.length);
  const deferred = (latest("gdpr.notify_authority", "decision") ?? latest("gdpr.notify_authority", "recommendation"))?.decision.choice === "defer";
  if (clock?.dueAt && clock.remainingMs <= PHASED_WITHIN_MS && !settled("gdpr.notify_authority") && (pending || deferred)) {
    const why = deferred ? "deferred" : "pending facts to confirm";
    detail(
      `*Propose a phased notification (Art. 33(4)):* the CNIL deadline (${formatParis(clock.dueAt)}) is less than 12 h away and the decision is still ${why}. Notify now with what is known and complete it as facts come in.`,
    );
    out.push(`*Phased notification suggested (Art. 33(4)):* less than 12 h left, decision still ${why}.`);
  }

  if (stage === "decision") {
    // Every decidable obligation not yet signed for good, unless it is "not required" and nobody recommended anything.
    const needed = ours(assessment).filter((o) => !settled(o) && (statusOf(o) !== "not_required" || latest(o, "recommendation")));
    detail(needed.length ? `*Your decision is needed:* ${needed.map((o) => OBLIGATION_LABEL[o]).join("; ")}.` : "*No decision pending.*");
    out.push(needed.length ? `*Your decision is needed:* ${needed.map((o) => SHORT_LABEL[o]).join(", ")}.` : "*No decision pending.*");
  }
  return out;
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
