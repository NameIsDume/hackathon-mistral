import { BookText } from "lucide-react";
import { timeParis, type EventRow } from "@/lib/dashboard/view";
import { SEVERITY_LABEL } from "@/lib/dashboard/view";

// One human line per event — this column doubles as the breach register (Art. 33(5)):
// who knew what, when. Append-only, read straight from incident_events.
function line(e: EventRow): { label: string; detail: string } {
  switch (e.type) {
    case "signal":
      return { label: "Signal reçu", detail: e.excerpt };
    case "classification":
      return { label: e.isIncident ? "Classé comme incident" : "Écarté", detail: e.reason };
    case "extraction":
      return {
        label: e.status === "ok" ? "Faits extraits" : "Extraction indisponible",
        detail: e.brief ?? `${e.factKeys.length} fait(s) proposé(s)`,
      };
    case "notification":
      return { label: `DM → ${e.to.name}`, detail: e.preview };
    case "answer":
      return { label: "Réponse", detail: `${e.factKey} : ${e.answer} (${e.by.name})` };
    case "severity_confirmed":
      return { label: "Gravité confirmée", detail: `${SEVERITY_LABEL[e.value]} par ${e.by.name}` };
    case "awareness":
      return { label: "Prise de connaissance", detail: `confirmée par ${e.by.name} — départ du délai de 72 h` };
    case "decision":
      return {
        label: "Décision",
        detail: `${e.choice === "notify" ? "Notifier" : "Ne pas notifier"} — ${e.reasons}`,
      };
    case "draft":
      return { label: "Brouillon", detail: `${e.document} (${e.status})` };
    default:
      return { label: "Événement", detail: "" };
  }
}

export function EventTimeline({ events }: { events: EventRow[] }) {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <BookText className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Journal de l&apos;incident</h2>
        <span className="text-xs text-muted-foreground">· registre Art. 33(5)</span>
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
