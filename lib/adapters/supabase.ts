// Server-only persistence: the single place that talks to Supabase with the service role.
// Every write goes through record_event() (facts + event in one transaction, optimistic version, idempotency).
import { createClient } from "@supabase/supabase-js";
import { IncidentEvent, IncidentSnapshot } from "@/lib/domain";

let client: ReturnType<typeof createClient> | undefined;
export function db() {
  client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  return client;
}

export class VersionConflict extends Error {}
export class IncidentNotFound extends Error {}

// Severity is a fact like the others (proposed by the AI, confirmed by a human); it lives in facts.severity.
type Facts = IncidentSnapshot["facts"] & { severity?: IncidentSnapshot["severity"] };

export async function recordEvent(args: {
  incidentId: string;
  expectedVersion: number;
  actor: string;
  event: IncidentEvent;
  idempotencyKey: string;
  facts?: Facts; // full facts object after the change, or omit to keep them
  awarenessAt?: string; // sets incidents.awareness_at in the same transaction (R05)
}): Promise<number> {
  const { type, ...payload } = IncidentEvent.parse(args.event);
  const { data, error } = await db().rpc("record_event" as never, {
    p_incident: args.incidentId,
    p_expected_version: args.expectedVersion,
    p_actor: args.actor,
    p_type: type,
    p_payload: payload,
    p_idempotency_key: args.idempotencyKey,
    p_facts: args.facts ?? null,
    p_awareness_at: args.awarenessAt ?? null,
  } as never);
  if (error?.code === "PT409") throw new VersionConflict(error.message);
  if (error) throw new Error(error.message);
  return data as number;
}

export async function loadSnapshot(incidentId: string): Promise<IncidentSnapshot> {
  const [inc, sig] = await Promise.all([
    db().from("incidents").select("id, version, first_signal_at, awareness_at, facts").eq("id", incidentId).single(),
    db().from("signals").select("id").eq("incident_id", incidentId),
  ]);
  if (inc.error?.code === "PGRST116") throw new IncidentNotFound(incidentId); // .single() found no row
  if (inc.error) throw new Error(inc.error.message);
  if (sig.error) throw new Error(sig.error.message);
  const row = inc.data as { id: string; version: number; first_signal_at: string; awareness_at: string | null; facts: Facts };
  const { severity, ...facts } = row.facts;
  return IncidentSnapshot.parse({
    id: row.id,
    version: row.version,
    firstSignalAt: row.first_signal_at,
    awarenessAt: row.awareness_at,
    severity: severity ?? { value: null, state: "proposed", method: "llm", sources: [] },
    signalIds: (sig.data as { id: string }[]).map((s) => s.id),
    facts,
  });
}

export async function listEvents(incidentId: string) {
  const { data, error } = await db()
    .from("incident_events")
    .select("id, at, actor, type, payload")
    .eq("incident_id", incidentId)
    .order("id");
  if (error) throw new Error(error.message);
  return (data as { id: number; at: string; actor: string; type: string; payload: object }[]).map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    event: IncidentEvent.parse({ type: r.type, ...r.payload }),
  }));
}

// Incident list for the dashboard, newest first. The brief lives in the latest extraction event (incidents.brief stays null).
export async function listIncidents() {
  const [inc, ext] = await Promise.all([
    db().from("incidents").select("id, first_signal_at, facts").order("first_signal_at", { ascending: false }),
    db().from("incident_events").select("incident_id, payload").eq("type", "extraction").order("id"),
  ]);
  if (inc.error) throw new Error(inc.error.message);
  if (ext.error) throw new Error(ext.error.message);
  const briefs = new Map<string, string>();
  for (const e of ext.data as { incident_id: string; payload: { brief?: string } }[])
    if (e.payload.brief) briefs.set(e.incident_id, e.payload.brief);
  return (inc.data as { id: string; first_signal_at: string; facts: Facts }[]).map(({ id, first_signal_at, facts }) => {
    const { severity, ...rest } = facts;
    return {
      id,
      firstSignalAt: first_signal_at,
      severity: severity?.value ?? null,
      factsConfirmed: Object.values(rest).filter((f) => f?.state === "confirmed").length,
      factsTotal: Object.keys(rest).length,
      brief: briefs.get(id) ?? null,
    };
  });
}
