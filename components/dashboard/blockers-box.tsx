import { CircleCheckBig, CircleDot, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { blockers, type Blocker } from "@/lib/dashboard/insights";
import type { Obligation } from "@/lib/domain";
import type { EventRow } from "@/lib/dashboard/view";
import { cn } from "@/lib/utils";

const TONE: Record<Blocker["tone"], { dot: string; icon: typeof CircleDot }> = {
  urgent: { dot: "text-destructive", icon: TriangleAlert },
  waiting: { dot: "text-amber-500", icon: CircleDot },
  info: { dot: "text-muted-foreground", icon: CircleDot },
};

export function BlockersBox({
  events,
  obligations,
  awarenessAt,
}: {
  events: EventRow[];
  obligations: Obligation[];
  awarenessAt: string | null;
}) {
  const items = blockers(events, obligations, awarenessAt);

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Blockers</h2>
        {items.length > 0 && <span className="ml-auto text-xs font-medium text-amber-600 dark:text-amber-400">{items.length}</span>}
      </div>

      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheckBig className="size-4 text-emerald-500" />
          Nothing is blocking right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((b) => {
            const { dot, icon: Icon } = TONE[b.tone];
            return (
              <li key={b.id} className="flex items-start gap-2.5">
                <Icon className={cn("mt-0.5 size-4 shrink-0", dot)} />
                <div className="min-w-0">
                  <p className="text-sm leading-snug">{b.label}</p>
                  {b.hint && <p className="truncate text-xs text-muted-foreground">{b.hint}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
