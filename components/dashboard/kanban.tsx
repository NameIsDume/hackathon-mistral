"use client";

import { useState } from "react";
import { deriveColumns, formatDue, isOverdue, TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/lib/dashboard/tasks";
import { ROLE_LABEL, type EventRow } from "@/lib/dashboard/view";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

const FRESH_MS = 10_000; // a task that just turned Done stays in its column, green, this long, then goes to the backlog

// Read-only: one column per person, their open tasks stacked as cards, finished ones in a backlog. Everything is done from Slack.
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

  // Done at page load -> straight to the backlog; done since (Realtime refresh) -> green for FRESH_MS first.
  const doneIds = columns.flatMap((c) => c.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const [seen, setSeen] = useState(() => ({ ids: new Set(doneIds), freshUntil: {} as Record<string, number> }));
  const newlyDone = doneIds.filter((id) => !seen.ids.has(id));
  if (newlyDone.length)
    setSeen({ ids: new Set(doneIds), freshUntil: { ...seen.freshUntil, ...Object.fromEntries(newlyDone.map((id) => [id, now + FRESH_MS])) } });
  const fresh = (id: string) => (seen.freshUntil[id] ?? 0) > now;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
        <h2 className="font-serif text-3xl font-semibold">Who does what</h2>
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {done} of {total} actions done
        </span>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => {
          const open = col.tasks.filter((t) => t.status !== "done" || fresh(t.id));
          const backlog = col.tasks.filter((t) => t.status === "done" && !fresh(t.id));
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
                      justDone ? "border-emerald-500/60 bg-emerald-500/10" : "border-border bg-card",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", TASK_STATUS_TONE[t.status])}>
                        {TASK_STATUS_LABEL[t.status]}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-xs tabular-nums",
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

              {backlog.length > 0 && (
                <details className="group rounded-lg border border-border/60 px-4 py-3">
                  <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground">
                    Done · {backlog.length}
                  </summary>
                  <ul className="mt-3 flex flex-col gap-2">
                    {backlog.map((t) => (
                      <li key={t.id} className="flex gap-2 text-xs leading-snug text-muted-foreground">
                        <span className="text-emerald-400">✓</span>
                        <span>{t.title}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
