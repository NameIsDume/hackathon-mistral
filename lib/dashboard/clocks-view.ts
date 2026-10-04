// Presentation helpers for the obligation clocks (horloge). Pure and shared by
// server and client; the live countdown recomputes against `now` on the client.
import { deadline } from "@/lib/clocks";
import type { Obligation, ObligationStatus } from "@/lib/domain";

export const OBLIGATION_LABEL: Record<string, string> = {
  "gdpr.notify_authority": "CNIL notification",
  "gdpr.inform_subjects": "Tell the people affected",
  "gdpr.record_breach": "Breach register",
  "gdpr.notify_controller": "Tell the client",
};

export const obligationLabel = (id: string) => OBLIGATION_LABEL[id] ?? id;

export const OBLIGATION_SUB: Record<string, string> = {
  "gdpr.notify_authority": "within 72 hours",
  "gdpr.inform_subjects": "if the risk to them is high",
  "gdpr.record_breach": "keep it up to date",
  "gdpr.notify_controller": "only for a client's data",
};

export const STATUS_LABEL: Record<ObligationStatus, string> = {
  required: "Required",
  not_required: "Not required",
  undetermined: "To be determined",
  controller_duty: "Client's duty",
  controller_decides: "Client decides",
};

export const STATUS_TONE: Record<ObligationStatus, string> = {
  required: "bg-primary/12 text-primary",
  not_required: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  undetermined: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  controller_duty: "bg-muted text-muted-foreground",
  controller_decides: "bg-muted text-muted-foreground",
};

// "70 h 12" / "8 min" / "overdue".
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "overdue";
  const totalMin = Math.floor(remainingMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m} min`;
}

// A progress ratio 0–1 for a 72 h window, so the bar fills as the deadline nears.
export function elapsedRatio(dueMs: number, windowHours: number, now: number): number {
  const startMs = dueMs - windowHours * 3_600_000;
  const r = (now - startMs) / (dueMs - startMs);
  return Math.min(1, Math.max(0, r));
}

// "069:50:12" — a live HH:MM:SS countdown (hours may exceed 24 for a 72 h clock).
export function formatHMS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(sec)}`;
}

// Coarse "2 d 06 h" / "6 h 47" / "47 min", for the deadline list.
export function formatDHM(ms: number): string {
  if (ms <= 0) return "overdue";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d >= 1) return `${d} d ${String(h).padStart(2, "0")} h`;
  if (h >= 1) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m} min`;
}

type Timeline = { firstSignalAt: string; awarenessAt: string | null };

export type DueItem = {
  id: string;
  label: string;
  sub?: string;
  dueMs: number;
  remainingMs: number;
  overdue: boolean;
  provisional: boolean;
  windowHours: number;
};

// Every obligation/track that has a hard due date, soonest first — feeds the big
// "next deadline" timer and the deadline list.
export function dueItems(
  obligations: Obligation[],
  timeline: Timeline,
  tracks: { id: string; label: string; dueAt: string | null; basis?: string }[],
  now: number,
): DueItem[] {
  const items: DueItem[] = [];
  for (const o of obligations) {
    if (o.deadline?.policy !== "duration") continue;
    const c = deadline(o.deadline, timeline, new Date(now));
    if (c.dueAt === null || !("remainingMs" in c)) continue;
    items.push({
      id: o.id,
      label: obligationLabel(o.id),
      sub: OBLIGATION_SUB[o.id],
      dueMs: Date.parse(c.dueAt),
      remainingMs: c.remainingMs,
      overdue: c.overdue,
      provisional: c.provisional,
      windowHours: o.deadline.hours,
    });
  }
  const start = Date.parse(timeline.firstSignalAt);
  for (const t of tracks) {
    if (!t.dueAt) continue;
    const dueMs = Date.parse(t.dueAt);
    items.push({
      id: t.id,
      label: t.label,
      sub: t.basis,
      dueMs,
      remainingMs: dueMs - now,
      overdue: dueMs - now < 0,
      provisional: false,
      windowHours: Math.max(1, Math.round((dueMs - start) / 3_600_000)),
    });
  }
  return items.sort((a, b) => a.dueMs - b.dueMs);
}
