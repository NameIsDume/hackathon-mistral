import type { Role, Severity } from "@/lib/domain";

export type Reviewer = { role: Role; name: string };
export const DEFAULT_REVIEWER: Reviewer = { role: "it", name: "IT coordinator" };

export const SEVERITY_LABELS: Record<Severity, string> = {
  false_positive: "False positive",
  minimal: "Minimal",
  average: "Average",
  major: "Major",
};

// Fired after a successful write so <AssessmentPanel> refetches without any wiring.
export const REVIEW_SAVED = "review:saved";

export async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  window.dispatchEvent(new Event(REVIEW_SAVED));
  return res.json();
}

// ISO instant -> "YYYY-MM-DDTHH:mm" wall-clock time in Europe/Paris (value of <input type="datetime-local">).
export const toParisLocal = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).replace(" ", "T").slice(0, 16);

// Inverse: Paris wall-clock time -> UTC ISO instant. Two passes settle the offset across DST changes.
export function parisLocalToIso(local: string) {
  const wall = Date.parse(`${local}:00Z`);
  const offset = (t: number) => Date.parse(`${toParisLocal(new Date(t).toISOString())}:00Z`) - Math.floor(t / 60_000) * 60_000;
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t).toISOString();
}
