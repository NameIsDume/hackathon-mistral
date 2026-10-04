"use client";

import { Activity, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { deadline } from "@/lib/clocks";
import {
  dueItems,
  elapsedRatio,
  formatDHM,
  formatHMS,
  obligationLabel,
  OBLIGATION_SUB,
  STATUS_LABEL,
} from "@/lib/dashboard/clocks-view";
import type { ScenarioTrack } from "@/lib/dashboard/mock";
import { dateParis, SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/dashboard/view";
import type { Obligation, Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

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

type Row = { id: string; label: string; sub?: string; value: string; tone: "normal" | "late" | "muted" };

// Only required / undetermined obligations ask something of us; the others are listed muted with their status.
const ACTIVE = new Set<Obligation["status"]>(["required", "undetermined"]);

// One row per obligation (and demo track): remaining time, "without undue delay", "ongoing" or its status.
function rows(obligations: Obligation[], tracks: ScenarioTrack[], timeline: Timeline, now: number): Row[] {
  const out: Row[] = obligations.map((o) => {
    const base = { id: o.id, label: obligationLabel(o.id), sub: OBLIGATION_SUB[o.id] };
    if (!ACTIVE.has(o.status)) return { ...base, value: STATUS_LABEL[o.status].toLowerCase(), tone: "muted" };
    if (!o.deadline) return { ...base, value: "ongoing", tone: "normal" };
    const c = deadline(o.deadline, timeline, new Date(now));
    if (!("remainingMs" in c)) return { ...base, value: "without undue delay", tone: "normal" };
    return { ...base, value: formatDHM(c.remainingMs), tone: c.overdue ? "late" : "normal" };
  });
  for (const t of tracks) {
    const remaining = t.dueAt ? Date.parse(t.dueAt) - now : null;
    out.push({ id: t.id, label: t.label, sub: t.basis, value: remaining === null ? "no deadline" : formatDHM(remaining), tone: remaining !== null && remaining <= 0 ? "late" : "normal" });
  }
  // Countdowns first, then "without undue delay", "ongoing", and the muted ones last.
  const rank = (r: Row) => (r.tone === "muted" ? 3 : r.value === "ongoing" ? 2 : r.value === "without undue delay" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

// Crisis-cell identifier: a date·time stamp, in Europe/Paris, from detection.
const crisisId = (iso: string) => {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(d);
  return `#${date} · ${time}`;
};

export function Hero({ title, brief, severity, live, obligations, tracks, timeline, now, onOpenJournal }: Props) {
  // The nearest hard deadline among obligations that still ask something of us.
  const primary = dueItems(
    obligations.filter((o) => ACTIVE.has(o.status)),
    timeline,
    tracks,
    now,
  )[0];
  const list = rows(obligations, tracks, timeline, now);

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Crisis cell · active</span>
            <Badge className={cn("ml-1", SEVERITY_TONE[severity])}>Severity: {SEVERITY_LABEL[severity]}</Badge>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                live ? "bg-emerald-500/12 text-emerald-300" : "bg-muted text-muted-foreground",
              )}
            >
              <Activity className="size-3.5" />
              {live ? "Live" : "Demo"}
            </span>
          </div>

          <span className="font-mono text-sm tracking-wide text-muted-foreground tabular-nums">{crisisId(timeline.firstSignalAt)}</span>
          <h1 className="font-serif text-5xl font-semibold leading-[1.05] tracking-tight text-primary sm:text-6xl lg:text-7xl">{title}</h1>
          <p className="max-w-[70ch] text-base leading-relaxed text-foreground/85">{brief}</p>
        </div>

        <button
          type="button"
          onClick={onOpenJournal}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Incident log
          <ArrowRight className="size-4" />
        </button>
      </div>

      {/* Nearest hard deadline (left) and every obligation deadline (right), in one panel. */}
      <div className="grid gap-6 rounded-xl border border-border bg-card p-6 lg:grid-cols-[1.1fr_1px_1fr] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-3">
          {primary ? (
            <>
              <p className="text-xs font-medium text-muted-foreground">
                Time left · {primary.label}
                {primary.sub && ` (${primary.sub})`}
              </p>
              <span className={cn("font-mono text-6xl font-semibold tracking-tight tabular-nums sm:text-7xl", primary.overdue ? "text-destructive" : "text-primary")}>
                {primary.overdue ? "overdue" : formatHMS(primary.remainingMs)}
              </span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                due {dateParis(new Date(primary.dueMs).toISOString())}
                {primary.provisional && " · provisional (awareness not confirmed)"}
              </span>
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(elapsedRatio(primary.dueMs, primary.windowHours, now) * 100)}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-muted-foreground">Time left</p>
              <p className="font-serif text-2xl">No hard legal deadline is running.</p>
            </>
          )}
        </div>

        <div className="hidden bg-border lg:block" />

        <ul className="flex flex-col justify-center divide-y divide-border">
          {list.map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <span className={cn("min-w-0 text-sm", r.tone === "muted" && "text-muted-foreground")}>
                <span className="font-medium">{r.label}</span>
                {r.sub && <span className="text-xs text-muted-foreground"> · {r.sub}</span>}
              </span>
              <span
                className={cn(
                  "shrink-0 text-right font-mono text-sm tabular-nums",
                  r.tone === "late" ? "text-destructive" : r.tone === "muted" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {r.value}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
