import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { LiveRefresh } from "@/components/dashboard/live-refresh";
import { listIncidents } from "@/lib/adapters/supabase";
import { formatParis } from "@/lib/clocks";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/dashboard/view";

export const metadata = {
  title: "Incidents",
  description: "Chaque incident signalé sur Slack, avec son rapport suivi en direct.",
};

export const dynamic = "force-dynamic";

// Server component: every real incident, newest first. Read-only; everything is done from Slack.
export default async function IncidentsPage() {
  const incidents = await listIncidents();
  return (
    <div className="min-h-screen bg-background">
      <LiveRefresh />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-5 sm:p-7">
        <h1 className="text-xl font-semibold">Incidents</h1>
        {incidents.length === 0 && <p className="text-sm text-muted-foreground">Aucun incident pour le moment.</p>}
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {incidents.map((i) => (
            <li key={i.id}>
              <Link href={`/incidents/${i.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/50">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{i.id.slice(0, 8)}</span>
                  <span>· {formatParis(i.firstSignalAt)}</span>
                  {i.severity && <Badge className={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge>}
                  <span>
                    · {i.factsConfirmed}/{i.factsTotal} faits confirmés
                  </span>
                </div>
                <p className="text-sm">{i.brief ?? "Résumé en cours d'extraction."}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
