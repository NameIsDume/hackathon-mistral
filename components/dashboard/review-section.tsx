"use client";

import { ClipboardCheck } from "lucide-react";
import { AssessmentPanel, AwarenessControl, SeverityControl } from "@/components/review";
import type { Fact, Severity } from "@/lib/domain";

// Reviewers per the lawyers' flow (overrides the components' "IT coordinator" default):
// severity is confirmed by IT, the awareness time by the DPO (coordination).
const SEVERITY_BY = { role: "it", name: "Samuel Cohen" } as const;
const AWARENESS_BY = { role: "dpo", name: "Claire Dubois" } as const;

type Props = {
  incidentId: string;
  severity: Fact<Severity>;
  firstSignalAt: string;
  awarenessAt: string | null;
  live: boolean;
};

export function ReviewSection({ incidentId, severity, firstSignalAt, awarenessAt, live }: Props) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ClipboardCheck className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Révision &amp; validation humaine</h2>
        <span className="text-xs text-muted-foreground">· la décision reste à un humain</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <SeverityControl incidentId={incidentId} current={severity} proposedBy="Mistral" by={SEVERITY_BY} />
        <AwarenessControl
          incidentId={incidentId}
          firstSignalAt={firstSignalAt}
          awarenessAt={awarenessAt}
          by={AWARENESS_BY}
        />
      </div>

      {live ? (
        // Authoritative, API-backed view: refetches on each confirmation (review:saved).
        <AssessmentPanel incidentId={incidentId} />
      ) : (
        <p className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          Le panneau d&apos;évaluation en direct s&apos;affiche une fois connecté au backend (Supabase + incident réel). En mode
          démo, les horloges ci-dessus proviennent des données fictives.
        </p>
      )}
    </section>
  );
}
