// Derives the two at-a-glance panels (people involved, blocking points) from the
// raw events + the GDPR assessment. Pure; keeps the dashboard components dumb.
import type { Obligation, Role } from "@/lib/domain";
import { obligationLabel } from "./clocks-view";
import { DECIDABLE, factLabel } from "./tasks";
import { ROLE_LABEL, type EventRow } from "./view";

export type PersonStatus = "responded" | "waiting" | "unreachable" | "reporter" | "informed";

export type InvolvedPerson = {
  role: Role;
  name: string;
  status: PersonStatus;
  detail: string;
};

export const PERSON_STATUS_LABEL: Record<PersonStatus, string> = {
  responded: "Responded",
  waiting: "Waiting",
  unreachable: "Unreachable",
  reporter: "Reported",
  informed: "Informed",
};

// green = done, amber = awaited, red = problem, grey = informational.
export const PERSON_STATUS_DOT: Record<PersonStatus, string> = {
  responded: "bg-emerald-500",
  waiting: "bg-amber-500",
  unreachable: "bg-destructive",
  reporter: "bg-sky-500",
  informed: "bg-muted-foreground/50",
};

type NotifRow = Extract<EventRow, { type: "notification" }>;
type AnswerRow = Extract<EventRow, { type: "answer" }>;

export function peopleInvolved(events: EventRow[]): InvolvedPerson[] {
  const order: Role[] = [];
  const acc = new Map<Role, { name: string; notifs: NotifRow[]; answers: AnswerRow[]; reporter: boolean }>();
  const ensure = (role: Role, name: string) => {
    let e = acc.get(role);
    if (!e) {
      e = { name, notifs: [], answers: [], reporter: false };
      acc.set(role, e);
      order.push(role);
    }
    if (name && e.name === "—") e.name = name;
    return e;
  };

  for (const ev of events) {
    if (ev.type === "signal") ensure("reporter", ev.actor || "—").reporter = true;
    else if (ev.type === "notification") ensure(ev.to.role, ev.to.name).notifs.push(ev);
    else if (ev.type === "answer") ensure(ev.by.role, ev.by.name).answers.push(ev);
  }

  return order.map((role) => {
    const e = acc.get(role)!;
    const unreachable = e.notifs.some((n) => !n.delivered);
    const askedQuestions = e.notifs.some((n) => n.kind === "questions");
    let status: PersonStatus;
    let detail: string;
    if (unreachable) {
      status = "unreachable";
      detail = "message not delivered";
    } else if (e.answers.length > 0) {
      status = "responded";
      detail = `${e.answers.length} answer${e.answers.length > 1 ? "s" : ""}`;
    } else if (askedQuestions) {
      status = "waiting";
      detail = "answer expected";
    } else if (e.reporter) {
      status = "reporter";
      detail = "reported the incident";
    } else {
      status = "informed";
      detail = "was informed";
    }
    return { role, name: e.name, status, detail };
  });
}

export type Blocker = {
  id: string;
  label: string;
  hint?: string;
  tone: "urgent" | "waiting" | "info";
};

export function blockers(
  events: EventRow[],
  obligations: Obligation[],
  awarenessAt: string | null,
): Blocker[] {
  const out: Blocker[] = [];
  const answeredKeys = new Set(events.filter((e): e is AnswerRow => e.type === "answer").map((e) => e.factKey));
  const decided = new Set(events.filter((e) => e.type === "decision").map((e) => (e as Extract<EventRow, { type: "decision" }>).obligationId));

  // Undelivered DMs — someone needs a reminder.
  for (const e of events) {
    if (e.type === "notification" && !e.delivered)
      out.push({ id: `dm-${e.id}`, tone: "urgent", label: `Remind ${e.to.name} (${ROLE_LABEL[e.to.role]})`, hint: "message not delivered" });
  }

  // Awareness not confirmed → the clock is only provisional.
  if (!awarenessAt)
    out.push({ id: "awareness", tone: "urgent", label: "Confirm when we became aware", hint: "the clock is still provisional" });

  // Questions still open per obligation (facts to confirm), and awaited decisions.
  for (const o of obligations) {
    const open = o.factsToConfirm.filter((k) => !answeredKeys.has(k));
    if (o.status === "required" && open.length > 0)
      out.push({ id: `facts-${o.id}`, tone: "waiting", label: `${obligationLabel(o.id)}: facts to confirm`, hint: open.map(factLabel).join(" · ") });
    if (o.blockingQuestions.length > 0)
      out.push({ id: `bq-${o.id}`, tone: "waiting", label: `${obligationLabel(o.id)}: open questions`, hint: o.blockingQuestions.map(factLabel).join(" · ") });
    if (o.id in DECIDABLE && o.status === "required" && o.factsToConfirm.length === 0 && !decided.has(o.id))
      out.push({ id: `dec-${o.id}`, tone: "waiting", label: `Decision expected: ${obligationLabel(o.id)}`, hint: "a person must sign it off in Slack" });
  }

  return out;
}
