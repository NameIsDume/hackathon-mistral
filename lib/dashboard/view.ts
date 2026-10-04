// View model for the suivi dashboard (#12): shapes incident_events rows into
// the groups the UI renders — Slack DMs per role, responses, and the timeline.
// No Supabase or LLM type leaks here; it speaks only the domain contracts.
import type { IncidentEvent, Role, Severity } from "@/lib/domain";

// A stored row: the discriminated-union payload plus the audit columns.
export type EventRow = IncidentEvent & { id: string | number; at: string; actor: string };

export const ROLE_LABEL: Record<Role, string> = {
  reporter: "Signalement",
  it: "IT / Sécurité",
  business_owner: "Métier",
  dpo: "DPO",
  lawyer: "Juriste",
  management: "Direction",
  communications: "Communication",
};

// A distinct, harmonious hue per role for the avatar chip. Tailwind-safe literals.
export const ROLE_ACCENT: Record<Role, string> = {
  reporter: "bg-stone-500/15 text-stone-700 dark:text-stone-300",
  it: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  business_owner: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  dpo: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  lawyer: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  management: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  communications: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  false_positive: "Faux positif",
  minimal: "Mineur",
  average: "Moyen",
  major: "Majeur",
};

export const SEVERITY_TONE: Record<Severity, string> = {
  false_positive: "bg-muted text-muted-foreground",
  minimal: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  average: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  major: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

export const NOTIFICATION_KIND_LABEL: Record<
  Extract<IncidentEvent, { type: "notification" }>["kind"],
  string
> = {
  brief: "Brief d'incident",
  questions: "Questions",
  assessment: "Évaluation",
  management_note: "Note à la direction",
  decision: "Décision",
};

export const ANSWER_LABEL: Record<Extract<IncidentEvent, { type: "answer" }>["answer"], string> = {
  yes: "Oui",
  no: "Non",
  unknown: "Inconnu",
};

export const ANSWER_TONE: Record<Extract<IncidentEvent, { type: "answer" }>["answer"], string> = {
  yes: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  no: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  unknown: "bg-muted text-muted-foreground",
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

const timeFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  hour: "2-digit",
  minute: "2-digit",
});

export const timeParis = (iso: string) => timeFmt.format(new Date(iso));

// One Slack conversation: the person and every DM/answer involving their role, in order.
export type RoleThread = {
  role: Role;
  person: string;
  notifications: Array<Extract<EventRow, { type: "notification" }>>;
  answers: Array<Extract<EventRow, { type: "answer" }>>;
  lastAt: string;
};

export function threadsByRole(events: EventRow[]): RoleThread[] {
  const map = new Map<Role, RoleThread>();
  const ensure = (role: Role, person: string, at: string): RoleThread => {
    const existing = map.get(role);
    if (existing) {
      if (at > existing.lastAt) existing.lastAt = at;
      if (person && existing.person === "—") existing.person = person;
      return existing;
    }
    const created: RoleThread = { role, person: person || "—", notifications: [], answers: [], lastAt: at };
    map.set(role, created);
    return created;
  };

  for (const e of events) {
    if (e.type === "notification") ensure(e.to.role, e.to.name, e.at).notifications.push(e);
    else if (e.type === "answer") ensure(e.by.role, e.by.name, e.at).answers.push(e);
  }
  return [...map.values()].sort((a, b) => a.lastAt.localeCompare(b.lastAt));
}

export const answers = (events: EventRow[]) =>
  events.filter((e): e is Extract<EventRow, { type: "answer" }> => e.type === "answer");
