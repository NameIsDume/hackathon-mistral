import { notFound } from "next/navigation";
import { z } from "zod";
import { Dashboard } from "@/components/dashboard/dashboard";
import { IncidentNotFound, listEvents, loadSnapshot } from "@/lib/adapters/supabase";
import { latestBrief, toEventRows } from "@/lib/dashboard/view";
import { evaluate } from "@/lib/regulations/gdpr";

export const metadata = {
  title: "Rapport d'incident",
  description: "Incident réel : faits, réponses par rôle et horloges d'obligations, en direct.",
};

// Every request (and every Realtime refresh) reloads the incident and re-runs the rules.
export const dynamic = "force-dynamic";

// Server component: real snapshot + events (service role, server only) and the real GDPR
// assessment. The client layers the live countdown and Realtime refresh on top.
export default async function IncidentPage({ params }: PageProps<"/incidents/[id]">) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  let snapshot, rows;
  try {
    [snapshot, rows] = await Promise.all([loadSnapshot(id.data), listEvents(id.data)]);
  } catch (e) {
    if (e instanceof IncidentNotFound) notFound();
    throw e;
  }
  const events = toEventRows(rows);
  // No severity before extraction: show "moyen" (the AI's neutral default) until a human confirms.
  const severityValue = snapshot.severity.value ?? "average";

  return (
    <Dashboard
      incident={{
        id: snapshot.id,
        company: "",
        title: `Incident ${snapshot.id.slice(0, 8)}`,
        brief: latestBrief(events) ?? "Résumé en cours d'extraction.",
        severity: severityValue,
        firstSignalAt: snapshot.firstSignalAt,
        awarenessAt: snapshot.awarenessAt,
      }}
      severity={snapshot.severity}
      obligations={evaluate(snapshot).obligations}
      events={events}
      // ponytail: no insurer/police/ransom tracks for real incidents (the engine does not model them); per-role work is the Kanban, derived from events.
      tracks={[]}
      // eslint-disable-next-line react-hooks/purity -- intentional request-time seed; the page is force-dynamic and the client ticks from here
      nowSeed={Date.now()}
    />
  );
}
