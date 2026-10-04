// Role-based Slack DMs (#25). Each role's DM is built strictly from what ROLE_MATRIX lets that role see.
import { z } from "zod";
import type { Assessment, IncidentEvent, IncidentSnapshot, Role, Severity } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS, GDPR_QUESTIONS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { db, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { briefBlocks, openDm, postDm, questionBlocks, section, type Block } from "@/lib/adapters/slack";
import { deadline, formatParis } from "@/lib/clocks";

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
  questions: boolean; // blocking facts whose owner (GDPR_FACTS[k].role) is this role
  decision: boolean; // asked to decide when informing the people concerned is undetermined
};
const NONE = { ack: false, brief: false, facts: false, assessment: false, clock: false, questions: false, decision: false } as const;

export const ROLE_MATRIX: Record<Role, RoleRule | null> = {
  reporter: { ...NONE, kind: "brief", ack: true },
  it: { ...NONE, kind: "questions", brief: true, questions: true },
  business_owner: { ...NONE, kind: "questions", brief: true, questions: true },
  dpo: { ...NONE, kind: "assessment", brief: true, facts: true, assessment: "full", clock: true, questions: true },
  lawyer: { ...NONE, kind: "assessment", brief: true, assessment: "full", clock: true, decision: true },
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

const OBLIGATION_LABEL: Record<string, string> = {
  "gdpr.record_breach": "Record the breach in the internal register",
  "gdpr.notify_controller": "Inform the client (we act as processor)",
  "gdpr.notify_authority": "Notify the data protection authority (CNIL)",
  "gdpr.inform_subjects": "Inform the people concerned",
};

export const isBooleanFact = (key: string) => key in GDPR_FACTS && GDPR_FACTS[key as GdprFactKey].value instanceof z.ZodBoolean;

export type Dm = { kind: Kind; blocks: Block[]; text: string; questionIds: string[] };
type Ctx = { snapshot: IncidentSnapshot; assessment: Assessment; brief: string | null; now: Date };

// Pure: the DM a role receives, or null when the role receives nothing.
export function buildDm(role: Role, { snapshot, assessment, brief, now }: Ctx): Dm | null {
  const rule = ROLE_MATRIX[role];
  if (!rule) return null;
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
      return `• ${k}: ${f.value === null ? "unknown" : JSON.stringify(f.value)} (${f.state}, ${f.method})${src ? ` — ${src}` : ""}`;
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
  if (rule.clock) {
    const d = assessment.obligations.find((o) => o.id === "gdpr.notify_authority")?.deadline;
    const c = d && deadline(d, snapshot, now);
    if (c?.dueAt)
      para(`*72h authority deadline:* ${formatParis(c.dueAt)}${c.provisional ? " (provisional: counted from the first signal until awareness is confirmed)" : ""}`);
  }
  if (rule.decision && assessment.obligations.find((o) => o.id === "gdpr.inform_subjects")?.status === "undetermined")
    para("*Your decision is needed:* whether to inform the people concerned (GDPR Art. 34) is undetermined. Please decide in the dashboard.");

  const questions = rule.questions
    ? [...new Set(assessment.obligations.flatMap((o) => o.blockingQuestions))]
        .map((k) => GDPR_QUESTIONS.find((q) => q.factKey === k))
        .filter((q) => q?.role === role)
        .map((q) => q!)
    : [];
  if (questions.length) para(`*${questions.length === 1 ? "One question" : `${questions.length} questions`} for you*`);
  for (const q of questions) {
    if (isBooleanFact(q.factKey)) {
      blocks.push(...questionBlocks(snapshot.id, q.factKey, q.text));
      lines.push(q.text);
    } else para(`• ${q.text} _(${role === "dpo" ? "please record it in the dashboard" : "please reply to the DPO"})_`);
  }

  if (!lines.length) return null;
  const title = { reporter: "Report received", management: "Incident note for management" }[role as string] ?? "Incident update";
  return { kind: rule.kind, blocks: [...briefBlocks(title, []), ...blocks], text: lines.join("\n\n"), questionIds: questions.map((q) => q.id) };
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
export async function notifyWave(incidentId: string, now = new Date(), roles?: Role[]) {
  const snapshot = await loadSnapshot(incidentId);
  const assessment = evaluate(snapshot);
  roles ??= waveFor(snapshot.severity.value);
  const [people, events] = await Promise.all([
    db().from("people").select("id, name, role, slack_user_id").in("role", roles),
    db().from("incident_events").select("type, payload, idempotency_key").eq("incident_id", incidentId).order("id"),
  ]);
  if (people.error) throw new Error(people.error.message);
  if (events.error) throw new Error(events.error.message);
  const rows = events.data as EventRow[];
  const brief = rows.findLast((r) => r.type === "extraction" && r.payload.brief)?.payload.brief ?? null;

  let version = snapshot.version;
  const results: { person: string; role: Role; delivered: boolean; error?: string; skipped?: true }[] = [];
  for (const p of people.data as PersonRow[]) {
    const dm = buildDm(p.role, { snapshot, assessment, brief, now });
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
      actor: "notify",
      idempotencyKey: prefix + snapshot.version,
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
