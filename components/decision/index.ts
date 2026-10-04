// Usage (dashboard, client or server page):
//
//   import { DecisionForm } from "@/components/decision";
//   <DecisionForm incidentId={incident.id} obligationId="gdpr.notify_authority" signerName="Claire Martin" />
//
// One form per obligation ("gdpr.notify_authority" | "gdpr.inform_subjects" | "gdpr.notify_controller").
// It fetches GET /api/decisions itself and posts to POST /api/decide (needs the demo_key cookie).
// It loads once on mount: to refresh after facts change (Realtime), remount it, e.g. key={incident.version}.
export { DecisionForm } from "./DecisionForm";
