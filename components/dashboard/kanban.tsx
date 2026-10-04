import { Card } from "@/components/ui/card";
import { deriveColumns, TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/lib/dashboard/tasks";
import { ROLE_LABEL, type EventRow } from "@/lib/dashboard/view";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

export function Kanban({
  events,
  obligations,
  severity,
  awarenessAt,
}: {
  events: EventRow[];
  obligations: Obligation[];
  severity: Fact<Severity>;
  awarenessAt: string | null;
}) {
  const columns = deriveColumns(events, obligations, severity, awarenessAt);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Qui fait quoi</h2>
        <span className="text-xs text-muted-foreground">· suivi par personne</span>
      </div>

      <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2 lg:grid-flow-row lg:auto-cols-auto lg:grid-cols-5">
        {columns.map((col) => (
          <div key={col.role} className="flex min-w-0 flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{ROLE_LABEL[col.role]}</p>
                <p className="truncate text-sm font-semibold">{col.name}</p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {col.done}/{col.total}
              </span>
            </div>

            <div className="flex flex-col gap-2.5">
              {col.tasks.map((t) => (
                <Card key={t.id} size="sm" className="gap-2 p-3.5">
                  <span className={cn("w-fit rounded-full px-2 py-0.5 text-[11px] font-medium", TASK_STATUS_TONE[t.status])}>
                    {TASK_STATUS_LABEL[t.status]}
                  </span>
                  <p className="text-sm font-medium leading-snug">{t.title}</p>
                  {t.hint && <p className="text-xs leading-snug text-destructive">{t.hint}</p>}
                  {t.meta && <p className="text-xs text-muted-foreground tabular-nums">{t.meta}</p>}
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
