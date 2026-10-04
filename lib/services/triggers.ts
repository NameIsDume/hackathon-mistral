// Automatic Slack DMs (#40): nobody has to press a button, everything starts from Slack.
//
//   intake "created" ──▶ afterIntake ──▶ notifyWave (whole wave of the proposed severity)
//   severity confirmed ──▶ afterSeverityChange ──▶ notifyWave (only the roles the new severity adds)
import type { Role, Severity } from "@/lib/domain";
import type { IntakeResult } from "@/lib/services/ingest";
import { notifyWave, waveFor } from "@/lib/services/notify";
import { confirmSeverity, type Reviewer } from "@/lib/services/review";

// A replay sends nothing. Not an incident, or extraction unavailable (no brief, no proposed severity):
// only the people holding the reporter role get their acknowledgement. Classification failure (null) fails open.
export async function afterIntake(result: IntakeResult) {
  if (result.status !== "created") return [];
  const full = result.isIncident !== false && result.extraction === "ok";
  return notifyWave(result.incidentId, new Date(), full ? undefined : ["reporter"]);
}

// Roles in the new wave that the previous wave did not reach (average -> major: management only).
export function newlyConcerned(previous: Severity | null, value: Severity): Role[] {
  const before = waveFor(previous);
  return waveFor(value).filter((r) => !before.includes(r));
}

export async function afterSeverityChange(incidentId: string, previous: Severity | null, value: Severity) {
  const roles = newlyConcerned(previous, value);
  return roles.length ? notifyWave(incidentId, new Date(), roles) : [];
}

// For callers already running in the background (e.g. a Slack interaction in after()): confirm, then notify.
export async function confirmSeverityAndNotify(incidentId: string, value: Severity, by: Reviewer) {
  const { version, previous } = await confirmSeverity(incidentId, value, by);
  await afterSeverityChange(incidentId, previous, value);
  return version;
}
