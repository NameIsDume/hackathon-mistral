// Intake pipeline: signal -> incident -> classification -> extraction (proposed facts + brief + severity).
//
//   signals (unique per workspace/connector/externalId)
//      │ replay of the same externalId -> return the existing incident, write nothing
//      ▼
//   incidents (version 1) ── record_event: signal ─▶ classification ─▶ extraction (+ facts)
//
// A failed or "not an incident" classification never deletes the signal (R06): it stays recorded.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MODELS, intake as runIntake } from "@/lib/adapters/mistral";
import { db, recordEvent } from "@/lib/adapters/supabase";

export const IntakeInput = z.object({
  text: z.string().trim().min(1).max(4000),
  actor: z.string().trim().min(1).max(200).default("demo-user"),
  externalId: z.string().trim().min(1).max(200).optional(), // the demo UI sends one per post
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
export type IntakeInput = z.input<typeof IntakeInput>;

export type IntakeResult =
  | { status: "replayed"; incidentId: string | null }
  | {
      status: "created";
      incidentId: string;
      isIncident: boolean | null; // null = classification failed (fail open)
      extraction: "ok" | "unavailable" | "skipped";
      provenance: string | null;
      recordedDemo: boolean;
      brief: string | null;
    };

const WORKSPACE = "demo";

// connectorId is set by the server route (demo UI or Slack), never taken from the request body.
export async function ingestSignal(raw: IntakeInput, connectorId = "demo"): Promise<IntakeResult> {
  const input = IntakeInput.parse(raw);
  const externalId = input.externalId ?? randomUUID();
  const occurredAt = input.occurredAt ?? new Date().toISOString();

  // 1. Signal first: the unique constraint makes a replay a no-op.
  const sig = await db()
    .from("signals")
    .insert({
      workspace_id: WORKSPACE,
      connector_id: connectorId,
      external_id: externalId,
      occurred_at: occurredAt,
      actor: input.actor,
      content: input.text,
    } as never)
    .select("id")
    .single();
  if (sig.error?.code === "23505") {
    const existing = await db()
      .from("signals")
      .select("incident_id")
      .eq("workspace_id", WORKSPACE)
      .eq("connector_id", connectorId)
      .eq("external_id", externalId)
      .single();
    return { status: "replayed", incidentId: (existing.data as { incident_id: string | null } | null)?.incident_id ?? null };
  }
  if (sig.error) throw new Error(sig.error.message);
  const signalId = (sig.data as { id: string }).id;

  // 2. Incident, linked to its signal. Awareness defaults to the report time (earliest, so the safest 72 h clock);
  // the DPO can still correct it from Slack.
  const inc = await db().from("incidents").insert({ first_signal_at: occurredAt, awareness_at: occurredAt } as never).select("id").single();
  if (inc.error) throw new Error(inc.error.message);
  const incidentId = (inc.data as { id: string }).id;
  const link = await db().from("signals").update({ incident_id: incidentId } as never).eq("id", signalId);
  if (link.error) throw new Error(link.error.message);

  let version = await recordEvent({
    incidentId,
    expectedVersion: 1,
    actor: input.actor,
    idempotencyKey: `signal:${signalId}`,
    event: { type: "signal", signalId, connectorId, actor: input.actor, excerpt: input.text.slice(0, 280) },
  });

  // 3. Mistral: one 12 s budget for classify + extract.
  const { classification, extraction } = await runIntake(input.text);
  version = await recordEvent({
    incidentId,
    expectedVersion: version,
    actor: "mistral",
    idempotencyKey: `classification:${signalId}`,
    event: {
      type: "classification",
      isIncident: classification?.isIncident ?? true,
      reason: classification?.reason ?? "Classification unavailable: kept for review (fail open).",
      provenance: classification ? MODELS.classify : null,
    },
  });

  if (!extraction)
    return { status: "created", incidentId, isIncident: false, extraction: "skipped", provenance: null, recordedDemo: false, brief: null };

  const ok = extraction.status === "ok";
  await recordEvent({
    incidentId,
    expectedVersion: version,
    actor: ok ? extraction.provenance : "mistral",
    idempotencyKey: `extraction:${signalId}`,
    event: {
      type: "extraction",
      status: extraction.status,
      provenance: extraction.provenance,
      recordedDemo: ok && extraction.recordedDemo,
      brief: ok ? extraction.brief : null,
      factKeys: ok ? Object.keys(extraction.facts).filter((k) => extraction.facts[k as keyof typeof extraction.facts].value !== null) : [],
    },
    facts: ok ? { ...extraction.facts, severity: extraction.severity } : undefined,
  });

  return {
    status: "created",
    incidentId,
    isIncident: classification?.isIncident ?? null,
    extraction: extraction.status,
    provenance: extraction.provenance,
    recordedDemo: ok && extraction.recordedDemo,
    brief: ok ? extraction.brief : null,
  };
}
