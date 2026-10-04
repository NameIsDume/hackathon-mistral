"use client";

import { Badge } from "@/components/ui/badge";
import { deadline, formatParis } from "@/lib/clocks";
import { elapsedRatio, formatRemaining, obligationLabel } from "@/lib/dashboard/clocks-view";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/dashboard/view";
import type { Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

type Timeline = { firstSignalAt: string; awarenessAt: string | null };

type Props = {
  title: string;
  brief: string;
  severity: Severity;
  obligations: Obligation[];
  timeline: Timeline;
  now: number;
};

// The one deadline that matters at a glance: notify the authority (72 h).
const PRIMARY_ID = "gdpr.notify_authority";

export function Hero({ title, brief, severity, obligations, timeline, now }: Props) {
  const primary = obligations.find((o) => o.id === PRIMARY_ID && o.deadline?.policy === "duration");
  const clock = primary?.deadline ? deadline(primary.deadline, timeline, new Date(now)) : null;
  const hasCountdown = clock !== null && clock.dueAt !== null && "remainingMs" in clock;
  const overdue = hasCountdown && "overdue" in clock && clock.overdue;
  const ratio = hasCountdown && "remainingMs" in clock ? elapsedRatio(now + clock.remainingMs, 72, now) : 0;

  return (
    <section className="grid gap-6 rounded-2xl border border-border bg-card p-6 ring-1 ring-foreground/5 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge className={cn(SEVERITY_TONE[severity])}>{SEVERITY_LABEL[severity]}</Badge>
          {timeline.awarenessAt ? (
            <span className="text-xs text-muted-foreground">
              Prise de connaissance · {formatParis(timeline.awarenessAt)}
            </span>
          ) : (
            <span className="text-xs text-amber-600 dark:text-amber-400">Prise de connaissance à confirmer</span>
          )}
        </div>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">{title}</h1>
        <p className="max-w-2xl text-sm leading-7 text-muted-foreground">{brief}</p>
      </div>

      {primary && (
        <div className="flex min-w-[15rem] flex-col gap-2 rounded-xl bg-muted/50 p-5">
          <p className="text-xs font-medium text-muted-foreground">{obligationLabel(primary.id)} · délai</p>
          {hasCountdown && "remainingMs" in clock ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className={cn("text-4xl font-semibold tabular-nums", overdue ? "text-destructive" : "text-foreground")}>
                  {formatRemaining(clock.remainingMs)}
                </span>
                {!overdue && <span className="text-sm text-muted-foreground">restantes</span>}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full rounded-full transition-all", overdue ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                échéance {formatParis(clock.dueAt!)}
                {clock.provisional && " · provisoire"}
              </p>
            </>
          ) : (
            <span className="text-lg font-medium">Sans délai indu</span>
          )}
        </div>
      )}
    </section>
  );
}
