// Derives the "who does what" board from the incident data: one row per involved
// person, each with task cards built from the questions routed to them, the
// confirmations they own (ROLE_MATRIX: severity and awareness are the DPO's), the
// recommendation/decision they sign (DPO recommends, lawyer decides) and the documents. Pure.
import type { Fact, Obligation, Role, Severity } from "@/lib/domain";
import { GDPR_FACTS } from "@/lib/regulations/gdpr/facts";
import type { EventRow } from "./view";

export type TaskStatus = "done" | "in_progress" | "pending_validation" | "todo" | "blocked";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  done: "Done",
  in_progress: "In progress",
  pending_validation: "Waiting for sign-off",
  todo: "To do",
  blocked: "Blocked",
};

export const TASK_STATUS_TONE: Record<TaskStatus, string> = {
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  in_progress: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  pending_validation: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  todo: "bg-muted text-muted-foreground",
  blocked: "bg-destructive/15 text-destructive",
};

// ponytail: provisional product values (hours after awareness, fallback first signal), pending the lawyers' validation.
// Only the 72 h is legal (GDPR Art. 33(1)); the rest are internal targets.
export const TASK_DUE_HOURS = { review: 1, question: 12, recommendation: 24, decision: 48, cnil: 72 } as const;

// Hours after awareness, or a policy without a countdown.
export type TaskDue = number | "without_undue_delay" | "ongoing";
export type Task = { id: string; title: string; status: TaskStatus; due: TaskDue; hint?: string };
export type Column = { role: Role; name: string; tasks: Task[]; done: number; total: number };

// "gdpr.personal_data" or "personal_data" -> the plain-language question from the catalogue.
export const factLabel = (k: string) => {
  const key = k.replace(/^gdpr\./, "");
  return (GDPR_FACTS as Record<string, { question: string }>)[key]?.question ?? key.replaceAll("_", " ");
};

// "T+12h" / "without undue delay" / "ongoing".
export const formatDue = (d: TaskDue) =>
  typeof d === "number" ? `T+${d}h` : d === "ongoing" ? "ongoing" : "without undue delay";

// A task is late when its relative deadline has passed and it is not done.
export const isOverdue = (t: Task, startMs: number, now: number) =>
  t.status !== "done" && typeof t.due === "number" && now > startMs + t.due * 3_600_000;

// Rows read top-down in the order the work flows: the DPO steers, then the people who answer, then sign-off.
const ROLE_ORDER: Role[] = ["dpo", "it", "business_owner", "lawyer", "management", "communications", "reporter"];

// Decisions the DPO recommends and the lawyer signs (lib/services/decide.ts DECIDABLE_OBLIGATIONS).
export const DECIDABLE: Record<string, string> = {
  "gdpr.notify_authority": "notifying the CNIL",
  "gdpr.inform_subjects": "informing the people concerned",
  "gdpr.notify_controller": "informing the client",
};
// Only these statuses ask something of us; not_required / controller_duty / controller_decides do not.
const needsAction = (o: Obligation | undefined): o is Obligation => o?.status === "required" || o?.status === "undetermined";

type NotifRow = Extract<EventRow, { type: "notification" }>;
type DecisionRow = Extract<EventRow, { type: "decision" }>;
type DraftRow = Extract<EventRow, { type: "draft" }>;

export function deriveColumns(
  events: EventRow[],
  obligations: Obligation[],
  severity: Fact<Severity>,
  facts: Record<string, Fact<unknown>>,
): Column[] {
  const people = new Map<Role, { name: string; notifs: NotifRow[] }>();
  for (const ev of events) {
    const who = ev.type === "notification" ? ev.to : ev.type === "answer" ? ev.by : null;
    if (!who || who.role === "reporter") continue;
    const p = people.get(who.role) ?? { name: who.name, notifs: [] };
    if (ev.type === "notification") p.notifs.push(ev);
    people.set(who.role, p);
  }

  const decisions = events.filter((e): e is DecisionRow => e.type === "decision");
  const signed = (id: string, stage: "recommendation" | "decision") =>
    decisions.findLast((d) => d.obligationId === id && (d.stage ?? "decision") === stage);
  const drafts = (doc: DraftRow["document"]) => events.filter((e): e is DraftRow => e.type === "draft" && e.document === doc);
  const docStatus = (doc: DraftRow["document"]): TaskStatus => {
    const d = drafts(doc);
    return d.some((x) => x.status === "sent") ? "done" : d.length ? "in_progress" : "todo";
  };
  const own = (id: string) => obligations.find((o) => o.id === id);

  const columns: Column[] = [];
  for (const role of ROLE_ORDER) {
    const p = people.get(role);
    if (!p) continue;
    const undelivered = p.notifs.some((n) => !n.delivered);
    const tasks: Task[] = [];

    // 1. Severity and awareness: the DPO's review controls (ROLE_MATRIX.dpo.review).
    if (role === "dpo") {
      tasks.push({
        id: "severity",
        title: "Confirm the severity",
        due: TASK_DUE_HOURS.review,
        status: severity.state === "confirmed" ? "done" : severity.value ? "in_progress" : "todo",
      });
      tasks.push({
        id: "awareness",
        title: "Confirm when we became aware (starts the 72 h clock)",
        due: TASK_DUE_HOURS.review,
        // Intake pre-fills awareness from the report; only an explicit confirmation counts.
        status: events.some((e) => e.type === "awareness") ? "done" : "in_progress",
      });
    }

    // 2. One card per fact asked of this person: confirmed = done, AI proposal awaiting confirmation = in progress.
    const asked = [...new Set(p.notifs.flatMap((n) => (n.kind === "questions" || n.kind === "assessment" ? n.questionIds : [])))];
    for (const q of asked) {
      const f = facts[q.replace(/^gdpr\./, "")];
      const known = f && f.value !== null && !f.dontKnowBy;
      const status: TaskStatus =
        known && f.state === "confirmed" ? "done" : undelivered ? "blocked" : known && f.state === "proposed" ? "in_progress" : "todo";
      tasks.push({ id: `q-${q}`, title: factLabel(q), due: TASK_DUE_HOURS.question, status, hint: status === "blocked" ? "message not delivered" : undefined });
    }

    // 3. Sign-off per obligation that asks something of us: the DPO recommends, the lawyer decides.
    for (const [id, what] of Object.entries(DECIDABLE)) {
      if (!needsAction(own(id))) continue;
      const rec = signed(id, "recommendation");
      const dec = signed(id, "decision");
      if (role === "dpo")
        tasks.push({ id: `rec-${id}`, title: `Recommend on ${what}`, due: TASK_DUE_HOURS.recommendation, status: rec || dec ? "done" : "todo" });
      if (role === "lawyer")
        tasks.push({
          id: `dec-${id}`,
          title: `Decide on ${what}`,
          due: TASK_DUE_HOURS.decision,
          status: dec ? "done" : undelivered ? "blocked" : rec ? "pending_validation" : "todo",
          hint: !dec && undelivered ? "message not delivered" : undefined,
        });
    }

    // 4. Documents the DPO sends and keeps.
    if (role === "dpo") {
      if (needsAction(own("gdpr.notify_authority")) && signed("gdpr.notify_authority", "decision")?.choice !== "do_not_notify")
        tasks.push({ id: "cnil", title: "Draft and send the CNIL notification", due: TASK_DUE_HOURS.cnil, status: docStatus("cnil_notification") });
      if (needsAction(own("gdpr.inform_subjects")) && signed("gdpr.inform_subjects", "decision")?.choice !== "do_not_notify")
        tasks.push({ id: "subjects", title: "Inform the people concerned", due: "without_undue_delay", status: docStatus("subjects_notice") });
      if (needsAction(own("gdpr.record_breach")))
        tasks.push({ id: "register", title: "Keep the breach register up to date", due: "ongoing", status: "in_progress" });
    }

    if (tasks.length === 0) continue;
    columns.push({ role, name: p.name, tasks, done: tasks.filter((t) => t.status === "done").length, total: tasks.length });
  }
  return columns;
}
