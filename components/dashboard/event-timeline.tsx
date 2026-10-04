import { BookText } from "lucide-react";
import { obligationLabel } from "@/lib/dashboard/clocks-view";
import { factLabel } from "@/lib/dashboard/tasks";
import { ANSWER_LABEL, followUp, notificationDetail, SEVERITY_LABEL, timeParis, type EventRow } from "@/lib/dashboard/view";

const CHOICE_LABEL = { notify: "go ahead", do_not_notify: "don't go ahead", defer: "wait for more facts" } as const;
const DOCUMENT_LABEL: Record<string, string> = { cnil_notification: "CNIL notification", breach_register: "Breach register", subjects_notice: "Notice to the people affected" };
const DRAFT_STATUS: Record<string, string> = { draft: "draft written", section_approved: "a section approved by the lawyer", sent: "sent" };

// One human line per event — this column doubles as the breach register (Art. 33(5)):
// who knew what, when. Append-only, read straight from incident_events.
function line(e: EventRow): { label: string; detail: string } {
  switch (e.type) {
    case "signal":
      return { label: "Signal received", detail: e.excerpt };
    case "classification":
      return { label: e.isIncident ? "Classified as an incident" : "Dismissed", detail: e.reason };
    case "extraction":
      return {
        label: e.status === "ok" ? "Facts extracted" : "Extraction unavailable",
        detail: e.brief ?? `${e.factKeys.length} fact(s) proposed`,
      };
    case "notification":
    {
      const f = followUp(e);
      if (f) return { label: f.kind === "question" ? `${f.from} asked ${e.to.name}` : `${f.from} replied to ${e.to.name}`, detail: f.text };
      return { label: `Slack message to ${e.to.name}`, detail: notificationDetail(e) };
    }
    case "answer":
      return { label: "Answer", detail: `${factLabel(e.factKey)} ${ANSWER_LABEL[e.answer]} (${e.by.name})` };
    case "severity_confirmed":
      return { label: "Severity confirmed", detail: `${SEVERITY_LABEL[e.value]}, by ${e.by.name}` };
    case "awareness":
      return { label: "Awareness time", detail: `confirmed by ${e.by.name}; the 72 h clock starts here` };
    case "decision":
      return {
        label: `${e.stage === "recommendation" ? "Recommendation" : "Decision"}: ${obligationLabel(e.obligationId)}`,
        detail: `${CHOICE_LABEL[e.choice]}, by ${e.by.name}`,
      };
    case "draft":
      return { label: DOCUMENT_LABEL[e.document] ?? "Document", detail: DRAFT_STATUS[e.status] ?? e.status };
    default:
      return { label: "Event", detail: "" };
  }
}

export function EventTimeline({ events }: { events: EventRow[] }) {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <BookText className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Incident log</h2>
        <span className="text-xs text-muted-foreground">· everything that happened, in order</span>
      </div>

      <ol className="relative flex flex-col gap-5 border-l border-border pl-6">
        {ordered.map((e) => {
          const { label, detail } = line(e);
          return (
            <li key={`${e.type}-${e.id}`} className="relative">
              <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary" />
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium">{label}</p>
                <time className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeParis(e.at)}</time>
              </div>
              {detail && <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{detail}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
