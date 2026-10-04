import { Dashboard } from "@/components/dashboard/dashboard";
import { mockAssessment, mockEvents, mockIncident, mockScenarioTracks, mockSnapshot } from "@/lib/dashboard/mock";

export const metadata = {
  title: "Suivi d'incident",
  description: "Incident, messages Slack par rôle, réponses et horloges d'obligations.",
};

// Render at request time so the countdown seed reflects "now", not build time.
export const dynamic = "force-dynamic";

// Server component: seeds the dashboard with the synthetic incident and the real
// GDPR assessment. The client component layers live countdown + Realtime on top.
export default function DashboardPage() {
  return (
    <Dashboard
      incident={mockIncident}
      severity={mockSnapshot.severity}
      obligations={mockAssessment.obligations}
      events={mockEvents}
      tracks={mockScenarioTracks}
      // eslint-disable-next-line react-hooks/purity -- intentional request-time seed; the page is force-dynamic and the client ticks from here
      nowSeed={Date.now()}
    />
  );
}
