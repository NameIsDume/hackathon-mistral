import { deriveColumns, formatDue, isOverdue, TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/lib/dashboard/tasks";
import { ROLE_LABEL, type EventRow } from "@/lib/dashboard/view";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

// Read-only: one row per person, their tasks as cards. Everything is done from Slack.
export function Kanban({
  events,
  obligations,
  severity,
  facts,
  startAt,
  now,
}: {
  events: EventRow[];
  obligations: Obligation[];
  severity: Fact<Severity>;
  facts: Record<string, Fact<unknown>>;
  startAt: string; // awareness, fallback first signal: relative deadlines count from here
  now: number;
}) {
  const columns = deriveColumns(events, obligations, severity, facts);
  const done = columns.reduce((n, c) => n + c.done, 0);
  const total = columns.reduce((n, c) => n + c.total, 0);
  const startMs = Date.parse(startAt);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
        <h2 className="font-serif text-3xl font-semibold">Who does what</h2>
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {done} of {total} actions done
        </span>
      </div>

      <div className="flex flex-col divide-y divide-border">
        {columns.map((col) => (
          <div key={col.role} className="grid gap-4 py-5 first:pt-0 md:grid-cols-[13rem_1fr] md:gap-6">
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{ROLE_LABEL[col.role]}</p>
              <p className="font-serif text-xl font-semibold leading-tight">{col.name}</p>
              <p className="font-mono text-xs text-muted-foreground tabular-nums">
                {col.done} / {col.total} done
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {col.tasks.map((t) => (
                <div key={t.id} className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", TASK_STATUS_TONE[t.status])}>
                      {TASK_STATUS_LABEL[t.status]}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-xs tabular-nums",
                        isOverdue(t, startMs, now) ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {formatDue(t.due)}
                    </span>
                  </div>
                  <p className="text-sm leading-snug">{t.title}</p>
                  {t.hint && <p className="text-xs leading-snug text-destructive">{t.hint}</p>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
