import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { LiveRefresh } from "@/components/dashboard/live-refresh";
import { listIncidents } from "@/lib/adapters/supabase";
import { dateParis, SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/dashboard/view";

export const metadata = {
  title: "Incidents",
  description: "Every incident reported on Slack, each with its live report.",
};

export const dynamic = "force-dynamic";

// Server component: every real incident, newest first. Read-only; everything is done from Slack.
export default async function IncidentsPage() {
  const incidents = await listIncidents();
  return (
    <div className="min-h-screen bg-background">
      <LiveRefresh />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:p-8">
        <h1 className="font-serif text-4xl font-semibold text-primary">Incidents</h1>
        {incidents.length === 0 && <p className="text-sm text-muted-foreground">No incident yet.</p>}
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
          {incidents.map((i) => (
            <li key={i.id}>
              <Link href={`/incidents/${i.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-accent">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{i.id.slice(0, 8)}</span>
                  <span>· {dateParis(i.firstSignalAt)}</span>
                  {i.severity && <Badge className={SEVERITY_TONE[i.severity]}>Severity: {SEVERITY_LABEL[i.severity]}</Badge>}
                  <span>
                    · {i.factsConfirmed}/{i.factsTotal} facts confirmed
                  </span>
                </div>
                <p className="text-sm">{i.brief ?? "Summary being extracted."}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
