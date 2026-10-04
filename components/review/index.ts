// Review pieces for the incident dashboard (#15). Wael: drop them into the page, e.g.
//
//   const { snapshot } = await (await fetch(`/api/assessment?incidentId=${id}`)).json(); // or loadSnapshot(id) server-side
//   <SeverityControl incidentId={id} current={snapshot.severity} proposedBy="Mistral" by={{ role: "it", name: "Alex" }} />
//   <AwarenessControl incidentId={id} firstSignalAt={snapshot.firstSignalAt} awarenessAt={snapshot.awarenessAt} />
//   <AssessmentPanel incidentId={id} />
//
// All three are client components. Writes need the demo_key cookie (same as /api/intake). After a successful write,
// a window "review:saved" event makes <AssessmentPanel> refetch on its own: no state to wire between them.
// `by` defaults to { role: "it", name: "IT coordinator" }.
export { AssessmentPanel } from "./assessment-panel";
export { AwarenessControl } from "./awareness-control";
export { SeverityControl } from "./severity-control";
