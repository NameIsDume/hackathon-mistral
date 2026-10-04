// Derives a per-person Kanban from the incident data: each involved role gets a
// column, each column a few task cards built from the questions routed to that
// role, the obligations it owns, and the confirmations it must make. Pure.
import type { Fact, Obligation, Role, Severity } from "@/lib/domain";
import type { EventRow } from "./view";

export type TaskStatus = "done" | "in_progress" | "pending_validation" | "todo" | "blocked";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  done: "Validée",
  in_progress: "En cours",
  pending_validation: "En attente de validation",
  todo: "À faire",
  blocked: "Bloquée",
};

export const TASK_STATUS_TONE: Record<TaskStatus, string> = {
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  in_progress: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  pending_validation: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  todo: "bg-muted text-muted-foreground",
  blocked: "bg-destructive/15 text-destructive",
};

export type Task = { id: string; title: string; meta?: string; status: TaskStatus; hint?: string };
export type Column = { role: Role; name: string; tasks: Task[]; done: number; total: number };

// Short French labels for the fact questions (the GDPR catalogue wording is English).
const FACT_LABEL: Record<string, string> = {
  personal_data: "Données personnelles concernées ?",
  breach_type: "Type de violation",
  data_categories: "Catégories de données",
  subjects_count: "Nombre de personnes",
  subjects_categories: "Qui sont les personnes",
  encrypted: "Données chiffrées ?",
  keys_safe: "Clés / mots de passe sûrs ?",
  still_exposed: "Donnée encore exposée ?",
  malicious: "Attaque délibérée ?",
  measures_taken: "Mesures de confinement",
  processing_role: "Responsable ou sous-traitant ?",
  cross_border: "Personnes hors de France ?",
  high_risk: "Risque élevé pour les personnes ?",
};
const factLabel = (k: string) => FACT_LABEL[k] ?? k;

type NotifRow = Extract<EventRow, { type: "notification" }>;
type AnswerRow = Extract<EventRow, { type: "answer" }>;

export function deriveColumns(
  events: EventRow[],
  obligations: Obligation[],
  severity: Fact<Severity>,
  awarenessAt: string | null,
): Column[] {
  const order: Role[] = [];
  const people = new Map<Role, { name: string; notifs: NotifRow[]; answers: AnswerRow[] }>();
  const ensure = (role: Role, name: string) => {
    let e = people.get(role);
    if (!e) {
      e = { name, notifs: [], answers: [] };
      people.set(role, e);
      order.push(role);
    }
    if (name && e.name === "—") e.name = name;
    return e;
  };
  for (const ev of events) {
    if (ev.type === "notification") ensure(ev.to.role, ev.to.name).notifs.push(ev);
    else if (ev.type === "answer") ensure(ev.by.role, ev.by.name).answers.push(ev);
  }

  const decided = new Set(
    events.filter((e) => e.type === "decision").map((e) => (e as Extract<EventRow, { type: "decision" }>).obligationId),
  );
  const hasDraft = events.some((e) => e.type === "draft");

  const columns: Column[] = [];

  for (const role of order) {
    const p = people.get(role)!;
    const answered = new Set(p.answers.map((a) => a.factKey));
    const delivered = p.notifs.some((n) => n.kind === "questions" && n.delivered);
    const anyUndelivered = p.notifs.some((n) => !n.delivered);
    const tasks: Task[] = [];

    // 1. Confirmations owned by the role.
    if (role === "it")
      tasks.push({
        id: `${role}-severity`,
        title: "Confirmer la gravité",
        meta: "T+1 h",
        status: severity.state === "confirmed" ? "done" : "todo",
      });
    if (role === "dpo")
      tasks.push({
        id: `${role}-awareness`,
        title: "Confirmer la prise de connaissance",
        meta: "départ du délai",
        status: awarenessAt ? "done" : "todo",
      });

    // 2. Questions routed to the role (one card per fact asked of them).
    const askedKeys: string[] = [];
    for (const n of p.notifs) if (n.kind === "questions") for (const k of n.questionIds) if (!askedKeys.includes(k)) askedKeys.push(k);
    for (const k of askedKeys) {
      const status: TaskStatus = answered.has(k) ? "done" : anyUndelivered ? "blocked" : delivered ? "in_progress" : "todo";
      tasks.push({
        id: `${role}-q-${k}`,
        title: factLabel(k),
        meta: "question",
        status,
        hint: status === "blocked" ? "message non délivré" : undefined,
      });
    }

    // 3. Obligations owned by the role.
    const own = (id: string) => obligations.find((o) => o.id === id);
    const obligationTask = (o: Obligation | undefined, title: string, meta: string): Task | null => {
      if (!o || o.status === "not_required") return null;
      let status: TaskStatus = "todo";
      if (decided.has(o.id)) status = hasDraft ? "pending_validation" : "in_progress";
      else if (o.factsToConfirm.length > 0) status = "in_progress";
      else if (o.status === "undetermined") status = "todo";
      return { id: `${role}-${o.id}`, title, meta, status, hint: o.factsToConfirm.length ? `faits : ${o.factsToConfirm.join(", ")}` : undefined };
    };
    if (role === "dpo") {
      const t1 = obligationTask(own("gdpr.notify_authority"), "Rédiger la notification CNIL", "T+72 h");
      if (t1) tasks.push(t1);
      const rec = own("gdpr.record_breach");
      if (rec && rec.status !== "not_required")
        tasks.push({ id: `${role}-record`, title: "Tenir le registre des violations", meta: "en continu", status: "in_progress" });
    }
    if (role === "lawyer") {
      const t = obligationTask(own("gdpr.inform_subjects"), "Décider de l'information des personnes", "Art. 34");
      if (t) tasks.push({ ...t, status: anyUndelivered ? "blocked" : t.status, hint: anyUndelivered ? "message non délivré" : t.hint });
    }
    if (role === "management")
      tasks.push({ id: `${role}-comm`, title: "Arbitrer la communication externe", meta: "T+48 h", status: "pending_validation" });

    if (tasks.length === 0) continue;
    const done = tasks.filter((t) => t.status === "done").length;
    columns.push({ role, name: p.name, tasks, done, total: tasks.length });
  }

  return columns;
}
