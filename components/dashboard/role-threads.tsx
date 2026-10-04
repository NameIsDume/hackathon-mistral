import { MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  ANSWER_LABEL,
  ANSWER_TONE,
  initials,
  NOTIFICATION_KIND_LABEL,
  notificationDetail,
  ROLE_ACCENT,
  ROLE_LABEL,
  threadsByRole,
  timeParis,
  type EventRow,
} from "@/lib/dashboard/view";
import { factLabel } from "@/lib/dashboard/tasks";
import { cn } from "@/lib/utils";

function Avatar({ role, name }: { role: keyof typeof ROLE_ACCENT; name: string }) {
  return (
    <span
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", ROLE_ACCENT[role])}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function RoleThreads({ events }: { events: EventRow[] }) {
  const threads = threadsByRole(events);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Slack messages per role</h2>
        <span className="text-xs text-muted-foreground">· what each person was asked and answered</span>
      </div>

      <div className="flex flex-col gap-3">
        {threads.map((thread) => (
          <Card key={thread.role} className="gap-0 p-5">
            <div className="flex items-center gap-3">
              <Avatar role={thread.role} name={thread.person} />
              <div className="min-w-0">
                <p className="truncate font-medium">{thread.person}</p>
                <p className="text-xs text-muted-foreground">{ROLE_LABEL[thread.role]}</p>
              </div>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{timeParis(thread.lastAt)}</span>
            </div>

            <ul className="mt-4 flex flex-col gap-3 border-l border-border pl-4">
              {thread.notifications.map((n) => (
                <li key={`n-${n.id}`} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                      {NOTIFICATION_KIND_LABEL[n.kind]}
                    </span>
                    {!n.delivered && (
                      <span className="rounded-full bg-destructive/12 px-2 py-0.5 text-[11px] font-medium text-destructive">
                        not delivered
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{timeParis(n.at)}</span>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">{notificationDetail(n)}</p>
                  {n.error && <p className="text-xs text-destructive">{n.error}</p>}
                </li>
              ))}

              {thread.answers.map((a) => (
                <li key={`a-${a.id}`} className="flex items-center gap-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", ANSWER_TONE[a.answer])}>
                    {ANSWER_LABEL[a.answer]}
                  </span>
                  <span className="min-w-0 truncate text-sm text-foreground">{factLabel(a.factKey)}</span>
                  <span className="text-[11px] text-muted-foreground">via {a.via === "slack" ? "Slack" : "web"}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{timeParis(a.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}
