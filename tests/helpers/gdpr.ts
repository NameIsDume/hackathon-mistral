import { Assessment, type IncidentSnapshot } from "@/lib/domain";
import { GdprModule } from "@/lib/regulations/gdpr";

export type State = "proposed" | "confirmed" | "disputed";
const STATES: unknown[] = ["proposed", "confirmed", "disputed"];
// A bare value is a fact in the default state; [value, state] sets the state explicitly.
export type Input = Record<string, unknown>;

export function snap(input: Input, defaultState: State = "proposed"): IncidentSnapshot {
  const facts: IncidentSnapshot["facts"] = {};
  for (const [k, raw] of Object.entries(input)) {
    const [value, state] =
      Array.isArray(raw) && raw.length === 2 && STATES.includes(raw[1]) ? (raw as [unknown, State]) : [raw, defaultState];
    facts[k] = { value, state, method: state === "confirmed" ? "human" : "llm", sources: [] };
  }
  return {
    id: "7bdfbd1d-57aa-42bb-8623-66a331d04e7b",
    version: 1,
    firstSignalAt: "2026-10-04T09:12:00+02:00",
    awarenessAt: null,
    severity: { value: null, state: "proposed", method: "llm", sources: [] },
    signalIds: [],
    facts,
  };
}

export const run = (input: Input, state?: State) => {
  const a = Assessment.parse(GdprModule.evaluate(snap(input, state)));
  const by = (id: string) => a.obligations.find((o) => o.id === `gdpr.${id}`)!;
  return { a, by };
};

export const NUVOLA = {
  personal_data: true,
  breach_type: ["confidentiality"],
  data_categories: ["contact"],
  subjects_count: 2400,
  encrypted: false,
  processing_role: "controller",
};

// Q6: the four encryption conditions plus the backup, all confirmed by IT.
export const ENCRYPTION_OK = {
  encrypted: [true, "confirmed"],
  encryption_state_of_art: [true, "confirmed"],
  keys_safe: [true, "confirmed"],
  encryption_covers_copies: [true, "confirmed"],
  backup_exists: [true, "confirmed"],
};
