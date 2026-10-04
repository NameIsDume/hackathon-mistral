import { Dashboard } from "@/components/dashboard/dashboard";
import { mockAssessment, mockEvents, mockIncident, mockScenarioTracks, mockSnapshot } from "@/lib/dashboard/mock";

export const metadata = {
  title: "Suivi d'incident",
  description: "Incident, messages Slack par rôle, réponses et horloges d'obligations.",
};

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
    />
  );
}
