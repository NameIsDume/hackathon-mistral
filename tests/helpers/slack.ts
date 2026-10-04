import type { IncidentSnapshot, Severity } from "@/lib/domain";

export const INCIDENT_ID = "7bdfbd1d-57aa-42bb-8623-66a331d04e7b";

export const NUVOLA = {
  personal_data: true,
  breach_type: ["confidentiality"],
  data_categories: ["contact"],
  subjects_count: 2400,
  encrypted: false,
  processing_role: "controller",
};

export function snap(values: Record<string, unknown>, severity: Severity | null = "average", version = 5): IncidentSnapshot {
  return {
    id: INCIDENT_ID,
    version,
    firstSignalAt: "2026-10-04T09:12:00+02:00",
    awarenessAt: null,
    severity: { value: severity, state: "proposed", method: "llm", sources: [] },
    signalIds: [],
    facts: Object.fromEntries(
      Object.entries(values).map(([k, value]) => [k, { value, state: "proposed", method: "llm", sources: [{ excerpt: `about ${k}` }] }]),
    ),
  };
}

// Minimal Supabase query-builder fake over arrays of rows: eq/in filter, maybeSingle takes the first row, other methods chain.
type Row = Record<string, unknown>;
export function fakeDb(tables: Record<string, Row[]>) {
  const query = (rows: Row[], single = false): unknown =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === "then") return (resolve: (v: unknown) => void) => resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
          if (k === "eq") return (c: string, v: unknown) => query(rows.filter((r) => r[c] === v), single);
          if (k === "in") return (c: string, vs: unknown[]) => query(rows.filter((r) => vs.includes(r[c])), single);
          if (k === "maybeSingle") return () => query(rows, true);
          return () => query(rows, single);
        },
      },
    );
  return () => ({ from: (t: string) => query(tables[t] ?? []) });
}

export const slackOk = (extra: object = {}) => new Response(JSON.stringify({ ok: true, ...extra }));
