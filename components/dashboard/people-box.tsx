import { Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { peopleInvolved, PERSON_STATUS_DOT, PERSON_STATUS_LABEL } from "@/lib/dashboard/insights";
import { initials, ROLE_ACCENT, ROLE_LABEL, type EventRow } from "@/lib/dashboard/view";
import { cn } from "@/lib/utils";

export function PeopleBox({ events }: { events: EventRow[] }) {
  const people = peopleInvolved(events);

  return (
    <Card className="gap-4 p-5">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">People involved</h2>
        <span className="ml-auto text-xs text-muted-foreground">{people.length}</span>
      </div>

      <ul className="flex flex-col gap-3">
        {people.map((p) => (
          <li key={p.role} className="flex items-center gap-3">
            <span
              className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", ROLE_ACCENT[p.role])}
              aria-hidden
            >
              {initials(p.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{p.name}</p>
              <p className="truncate text-xs text-muted-foreground">{ROLE_LABEL[p.role]}</p>
            </div>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-2 rounded-full", PERSON_STATUS_DOT[p.status])} />
              {PERSON_STATUS_LABEL[p.status]}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
