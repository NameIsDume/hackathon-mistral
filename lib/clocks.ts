// Obligation clocks (R05). Pure: no state, so correcting awarenessAt simply yields a new due date; nothing "restarts".
// Arithmetic is absolute elapsed time on UTC epoch milliseconds; Europe/Paris is display only.
import type { z } from "zod";
import type { Deadline } from "@/lib/domain";

type Timeline = { firstSignalAt: string; awarenessAt: string | null };

export type Clock =
  | { dueAt: string; provisional: boolean; remainingMs: number; overdue: boolean }
  | { dueAt: null; provisional: boolean; label: "without undue delay" };

export function deadline(d: z.infer<typeof Deadline>, timeline: Timeline, now: Date): Clock {
  // Before awareness is set, the first signal gives an explicitly provisional estimate.
  const provisional = timeline.awarenessAt === null;
  if (d.policy === "without_undue_delay") return { dueAt: null, provisional, label: "without undue delay" };
  const due = Date.parse(timeline.awarenessAt ?? timeline.firstSignalAt) + d.hours * 3_600_000;
  const remainingMs = due - now.getTime();
  return { dueAt: new Date(due).toISOString(), provisional, remainingMs, overdue: remainingMs < 0 };
}

const paris = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });

export const formatParis = (iso: string) => paris.format(new Date(iso));
