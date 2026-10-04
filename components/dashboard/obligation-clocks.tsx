"use client";

import { Clock, Gavel, Landmark, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { deadline } from "@/lib/clocks";
import { elapsedRatio, formatRemaining, obligationLabel, STATUS_LABEL, STATUS_TONE } from "@/lib/dashboard/clocks-view";
import type { ScenarioTrack } from "@/lib/dashboard/mock";
import { factLabel } from "@/lib/dashboard/tasks";
import { dateParis } from "@/lib/dashboard/view";
import type { Obligation } from "@/lib/domain";
import { cn } from "@/lib/utils";

type Timeline = { firstSignalAt: string; awarenessAt: string | null };

const OBLIGATION_ICON: Record<string, typeof Clock> = {
  "gdpr.notify_authority": Landmark,
  "gdpr.inform_subjects": Users,
  "gdpr.record_breach": Gavel,
  "gdpr.notify_controller": Users,
};

function ClockCard({ obligation, timeline, now }: { obligation: Obligation; timeline: Timeline; now: number }) {
  const d = obligation.deadline;
  const clock = d ? deadline(d, timeline, new Date(now)) : null;
  const Icon = OBLIGATION_ICON[obligation.id] ?? Clock;

  const hasCountdown = clock !== null && clock.dueAt !== null && "remainingMs" in clock;
  const overdue = hasCountdown && "overdue" in clock && clock.overdue;
  const provisional = clock?.provisional ?? false;
  const ratio = hasCountdown && "remainingMs" in clock ? elapsedRatio(now + clock.remainingMs, 72, now) : 0;

  return (
    <Card className="gap-0 p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[obligation.status])}>
          {STATUS_LABEL[obligation.status]}
        </span>
      </div>

      <p className="mt-3 text-sm font-medium leading-snug">{obligationLabel(obligation.id)}</p>

      {hasCountdown && "remainingMs" in clock ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className={cn("text-2xl font-semibold tabular-nums", overdue ? "text-destructive" : "text-foreground")}>
              {formatRemaining(clock.remainingMs)}
            </span>
            {!overdue && <span className="text-xs text-muted-foreground">left</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", overdue ? "bg-destructive" : "bg-primary")}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            due {dateParis(clock.dueAt!)}
            {provisional && " · provisional"}
          </p>
        </div>
      ) : d ? (
        <p className="mt-2 text-sm text-muted-foreground">Without undue delay · no countdown</p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Ongoing for the whole incident</p>
      )}

      {obligation.factsToConfirm.length > 0 && (
        <p className="mt-3 border-t border-border pt-3 text-xs text-amber-600 dark:text-amber-400">
          Facts to confirm: {obligation.factsToConfirm.map(factLabel).join(" · ")}
        </p>
      )}
    </Card>
  );
}

function TrackCard({ track, now }: { track: ScenarioTrack; now: number }) {
  const remaining = track.dueAt ? Date.parse(track.dueAt) - now : null;
  const overdue = remaining !== null && remaining <= 0;
  return (
    <Card className="gap-1.5 border-dashed p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">{track.label}</p>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{track.owner}</span>
      </div>
      {remaining !== null ? (
        <p className={cn("text-base font-semibold tabular-nums", overdue ? "text-destructive" : "text-foreground")}>
          {formatRemaining(remaining)}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">· {track.basis}</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{track.basis}</p>
      )}
      {track.note && <p className="text-xs leading-relaxed text-muted-foreground">{track.note}</p>}
    </Card>
  );
}

// Active countdowns first, then "without undue delay", then ongoing (no deadline).
const rank = (o: Obligation) =>
  o.deadline?.policy === "duration" ? 0 : o.deadline?.policy === "without_undue_delay" ? 1 : 2;

type Props = {
  obligations: Obligation[];
  timeline: Timeline;
  tracks: ScenarioTrack[];
  now: number;
};

export function ObligationClocks({ obligations, timeline, tracks, now }: Props) {
  const ordered = [...obligations].sort((a, b) => rank(a) - rank(b));
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Obligations &amp; clocks</h2>
        <span className="text-xs text-muted-foreground">· GDPR engine, confirmed facts</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ordered.map((o) => (
          <ClockCard key={o.id} obligation={o} timeline={timeline} now={now} />
        ))}
      </div>

      {tracks.length > 0 && (
        <div className="mt-1 flex flex-col gap-3">
          <p className="text-xs font-medium text-muted-foreground">
            Other legal deadlines, outside the GDPR engine (insurer, police complaint, ransom)
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {tracks.map((t) => (
              <TrackCard key={t.id} track={t} now={now} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
