// Human review of the incident: confirm or correct the severity, set the awareness time (R05, R08).
// Each action is one event; a correction is simply a new event, nothing restarts.
import { randomUUID } from "node:crypto";
import { loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import type { IncidentSnapshot, Role, Severity } from "@/lib/domain";

export type Reviewer = { role: Role; name: string };
export class InvalidAwareness extends Error {}

// Reload and retry once if someone else wrote in between; a second conflict goes up to the caller (409).
async function withRetry(incidentId: string, write: (s: IncidentSnapshot, key: string) => Promise<number>) {
  const key = randomUUID(); // a conflicting attempt inserts nothing, so the retry may reuse the key
  for (let attempt = 0; ; attempt++) {
    const snapshot = await loadSnapshot(incidentId);
    try {
      return await write(snapshot, key);
    } catch (e) {
      if (!(e instanceof VersionConflict) || attempt > 0) throw e;
    }
  }
}

// Returns the previous value too, so the caller can notify the roles the new severity adds (#40, lib/services/triggers.ts).
export async function confirmSeverity(incidentId: string, value: Severity, by: Reviewer) {
  let previous = null as Severity | null; // assigned in the callback (a plain annotation would stay narrowed to null)
  const version = await withRetry(incidentId, (s, key) => {
    previous = s.severity.value;
    return recordEvent({
      incidentId,
      expectedVersion: s.version,
      actor: by.name,
      event: { type: "severity_confirmed", by, value, previous: s.severity.value },
      idempotencyKey: key,
      facts: {
        ...s.facts,
        severity: { value, state: "confirmed", method: "human", sources: [], confirmedBy: by.name, confirmedAt: new Date().toISOString() },
      },
    });
  });
  return { version, previous };
}

export async function setAwareness(incidentId: string, at: string, by: Reviewer) {
  const t = Date.parse(at);
  if (t > Date.now()) throw new InvalidAwareness("awareness time is in the future");
  return withRetry(incidentId, (s, key) => {
    if (t < Date.parse(s.firstSignalAt)) throw new InvalidAwareness("awareness time is before the first signal");
    return recordEvent({
      incidentId,
      expectedVersion: s.version,
      actor: by.name,
      event: { type: "awareness", by, at, previousAt: s.awarenessAt },
      idempotencyKey: key,
      awarenessAt: at,
    });
  });
}
