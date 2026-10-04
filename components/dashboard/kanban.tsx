"use client";

import { useState } from "react";
import { deriveColumns, formatDue, isOverdue, TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/lib/dashboard/tasks";
import { ROLE_LABEL, type EventRow } from "@/lib/dashboard/view";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

const FRESH_MS = 10_000; // a task that just turned Done stays in its column, green, this long, then hides (shown again with "Completed")

// Read-only: one column per person, their open tasks stacked as cards; finished ones hidden unless "Completed" is on. Everything is done from Slack.
export function Kanban({
  events,
  obligations,
  severity,
  facts,
  startAt,
  awarenessAt,
  now,
}: {
  events: EventRow[];
  obligations: Obligation[];
  severity: Fact<Severity>;
  facts: Record<string, Fact<unknown>>;
  startAt: string; // awareness, fallback first signal: relative deadlines count from here
  awarenessAt: string | null;
  now: number;
}) {
  const columns = deriveColumns(events, obligations, severity, facts, awarenessAt);
  const done = columns.reduce((n, c) => n + c.done, 0);
  const total = columns.reduce((n, c) => n + c.total, 0);
  const startMs = Date.parse(startAt);

  // Done at page load -> hidden at once; done since (Realtime refresh) -> green for FRESH_MS first.
  const doneIds = columns.flatMap((c) => c.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const [seen, setSeen] = useState(() => ({ ids: new Set(doneIds), freshUntil: {} as Record<string, number> }));
  const newlyDone = doneIds.filter((id) => !seen.ids.has(id));
  if (newlyDone.length)
    setSeen({ ids: new Set(doneIds), freshUntil: { ...seen.freshUntil, ...Object.fromEntries(newlyDone.map((id) => [id, now + FRESH_MS])) } });
  const fresh = (id: string) => (seen.freshUntil[id] ?? 0) > now;
  const [showCompleted, setShowCompleted] = useState(false);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
        <h2 className="font-serif text-3xl font-semibold">Who does what</h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-muted-foreground tabular-nums">
            {done} of {total} actions done
          </span>
          <button
            type="button"
            aria-pressed={showCompleted}
            onClick={() => setShowCompleted((v) => !v)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              showCompleted ? "border-emerald-600/40 bg-emerald-500/15 text-emerald-700" : "border-border bg-card text-muted-foreground hover:bg-accent",
            )}
          >
            Completed · {done}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-6">
        {columns.map((col) => {
          const open = col.tasks.filter((t) => t.status !== "done" || fresh(t.id) || showCompleted);
          return (
            <div key={col.role} className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{ROLE_LABEL[col.role]}</p>
                <p className="font-serif text-xl font-semibold leading-tight">{col.name}</p>
                <p className="font-mono text-xs text-muted-foreground tabular-nums">
                  {col.done} / {col.total} done
                </p>
              </div>

              {open.map((t) => {
                const justDone = t.status === "done";
                return (
                  <div
                    key={t.id}
                    className={cn(
                      "flex flex-col gap-2.5 rounded-lg border p-4 transition-colors duration-500",
                      justDone
                        ? "border-emerald-500/60 bg-emerald-500/10"
                        : t.status === "pending_validation"
                          ? "border-amber-500/60 bg-amber-500/10"
                          : "border-border bg-card",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", TASK_STATUS_TONE[t.status])}>
                        {TASK_STATUS_LABEL[t.status]}
                      </span>
                      <span
                        className={cn(
                          "text-right font-mono text-xs tabular-nums",
                          !justDone && isOverdue(t, startMs, now) ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {formatDue(t.due)}
                      </span>
                    </div>
                    <p className="text-sm leading-snug">{t.title}</p>
                    {t.hint && <p className="text-xs leading-snug text-destructive">{t.hint}</p>}
                  </div>
                );
              })}
              {!open.length && <p className="text-sm text-muted-foreground">Nothing left to do.</p>}

            </div>
          );
        })}
      </div>
    </section>
  );
}
