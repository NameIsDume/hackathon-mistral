"use client";

import type { DueItem } from "@/lib/dashboard/clocks-view";
import { cn } from "@/lib/utils";

type Mark = { ratio: number; title: string; tlabel: string; align: "start" | "center" | "end" };

// Frise des délais: a single time axis from detection (T0) to the furthest
// deadline, with a live position dot and a milestone per obligation/track.
export function DeadlineTimeline({
  items,
  firstSignalAt,
  now,
}: {
  items: DueItem[];
  firstSignalAt: string;
  now: number;
}) {
  if (items.length === 0) return null;
  const t0 = Date.parse(firstSignalAt);
  const end = Math.max(...items.map((i) => i.dueMs));
  const span = end - t0;
  if (span <= 0) return null;

  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - t0) / span) * 100));
  const marker = pct(now);

  // Short milestone names so the labels stay on one line under each tick.
  const shortLabel = (label: string) => label.split(/ — | \(/)[0];

  // Detection at T0, then each deadline; drop milestones too close to keep labels legible.
  const marks: Mark[] = [{ ratio: 0, title: "Détection", tlabel: "T0", align: "start" }];
  let last = 0;
  for (const it of items) {
    const ratio = pct(it.dueMs);
    if (ratio - last < 16) continue;
    marks.push({
      ratio,
      title: shortLabel(it.label),
      tlabel: `T+${Math.round((it.dueMs - t0) / 3_600_000)} h`,
      align: ratio > 88 ? "end" : "center",
    });
    last = ratio;
  }

  const translate = (a: Mark["align"]) =>
    a === "start" ? "translateX(0)" : a === "end" ? "translateX(-100%)" : "translateX(-50%)";

  return (
    <div className="relative px-1 pb-7 pt-8">
      {/* labels above */}
      {marks.map((m, i) => (
        <span
          key={`t-${i}`}
          className="absolute top-0 whitespace-nowrap text-xs font-medium text-foreground"
          style={{ left: `${m.ratio}%`, transform: translate(m.align) }}
        >
          {m.title}
        </span>
      ))}

      {/* axis */}
      <div className="relative h-1.5 rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${marker}%` }} />
        {marks.map((m, i) => (
          <span
            key={`m-${i}`}
            className={cn("absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-border", m.ratio <= marker && "bg-primary/60")}
            style={{ left: `${m.ratio}%` }}
          />
        ))}
        <span
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm"
          style={{ left: `${marker}%` }}
        />
      </div>

      {/* T+ labels below */}
      {marks.map((m, i) => (
        <span
          key={`b-${i}`}
          className="absolute bottom-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums"
          style={{ left: `${m.ratio}%`, transform: translate(m.align) }}
        >
          {m.tlabel}
        </span>
      ))}
    </div>
  );
}
