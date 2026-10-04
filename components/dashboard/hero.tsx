"use client";

import { Activity, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatParis } from "@/lib/clocks";
import { dueItems, formatHMS, formatDHM } from "@/lib/dashboard/clocks-view";
import type { ScenarioTrack } from "@/lib/dashboard/mock";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/dashboard/view";
import type { Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { DeadlineTimeline } from "./deadline-timeline";

type Timeline = { firstSignalAt: string; awarenessAt: string | null };

type Props = {
  title: string;
  brief: string;
  severity: Severity;
  live: boolean;
  obligations: Obligation[];
  tracks: ScenarioTrack[];
  timeline: Timeline;
  now: number;
  onOpenJournal: () => void;
};

// Crisis-cell identifier: a date·time stamp, in Europe/Paris, from detection.
const crisisId = (iso: string) => {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(d);
  return `#${date} · ${time}`;
};

export function Hero({
  title,
  brief,
  severity,
  live,
  obligations,
  tracks,
  timeline,
  now,
  onOpenJournal,
}: Props) {
  const items = dueItems(obligations, timeline, tracks, now);
  const primary = items[0];
  const rest = items.slice(1);

  return (
    <section className="flex flex-col gap-7">
      {/* Blended header — no card, sits on the page ground. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Cellule de crise · active</span>
            <Badge className={cn("ml-1", SEVERITY_TONE[severity])}>Sévérité {SEVERITY_LABEL[severity].toLowerCase()}</Badge>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                live ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground",
              )}
            >
              <Activity className="size-3.5" />
              {live ? "Temps réel" : "Démo"}
            </span>
          </div>

          <span className="font-mono text-sm tracking-wide text-muted-foreground tabular-nums">{crisisId(timeline.firstSignalAt)}</span>
          <h1 className="max-w-4xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">{title}</h1>
          <p className="max-w-3xl truncate text-sm text-muted-foreground">{brief}</p>
        </div>

        <button
          type="button"
          onClick={onOpenJournal}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Journal de l&apos;incident
          <ArrowRight className="size-4" />
        </button>
      </div>

      {/* Timer + deadline list, in one subtle panel. */}
      {primary && (
        <div className="grid gap-6 rounded-xl border border-border bg-card p-6 ring-1 ring-foreground/5 lg:grid-cols-[1.1fr_1px_minmax(16rem,22rem)]">
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium text-muted-foreground">Temps restant · Alerte précoce (NIS2 · CSIRT)</p>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className={cn("font-mono text-6xl font-semibold tracking-tight tabular-nums", primary.overdue ? "text-destructive" : "text-foreground")}>
                {formatHMS(primary.remainingMs)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                échéance {formatParis(new Date(primary.dueMs).toISOString())}
              </span>
            </div>
            <div className="mt-3">
              <DeadlineTimeline items={items} firstSignalAt={timeline.firstSignalAt} now={now} />
            </div>
          </div>

          <div className="hidden bg-border lg:block" />

          <ul className="flex flex-col justify-center divide-y divide-border">
            {rest.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0 text-sm">
                  <span className="font-medium">{d.label}</span>
                  {d.sub && <span className="text-muted-foreground"> · {d.sub}</span>}
                </span>
                <span className={cn("shrink-0 text-sm font-semibold tabular-nums", d.overdue ? "text-destructive" : "text-foreground")}>
                  {formatDHM(d.remainingMs)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
