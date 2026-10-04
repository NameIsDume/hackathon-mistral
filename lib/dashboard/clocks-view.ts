// Presentation helpers for the obligation clocks (horloge). Pure and shared by
// server and client; the live countdown recomputes against `now` on the client.
import type { ObligationStatus } from "@/lib/domain";

export const OBLIGATION_LABEL: Record<string, string> = {
  "gdpr.notify_authority": "Notifier la CNIL",
  "gdpr.inform_subjects": "Informer les personnes concernées",
  "gdpr.record_breach": "Registre des violations",
  "gdpr.notify_controller": "Informer le responsable de traitement",
};

export const obligationLabel = (id: string) => OBLIGATION_LABEL[id] ?? id;

export const STATUS_LABEL: Record<ObligationStatus, string> = {
  required: "Requis",
  not_required: "Non requis",
  undetermined: "À déterminer",
};

export const STATUS_TONE: Record<ObligationStatus, string> = {
  required: "bg-primary/12 text-primary",
  not_required: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  undetermined: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

// "70 h 12" / "8 min" / "échéance dépassée".
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "échéance dépassée";
  const totalMin = Math.floor(remainingMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m} min`;
}

// A progress ratio 0–1 for a 72 h window, so the bar fills as the deadline nears.
export function elapsedRatio(dueMs: number, windowHours: number, now: number): number {
  const startMs = dueMs - windowHours * 3_600_000;
  const r = (now - startMs) / (dueMs - startMs);
  return Math.min(1, Math.max(0, r));
}
