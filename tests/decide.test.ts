import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentSnapshot } from "@/lib/domain";
import type { LoggedEvent } from "@/lib/services/decide";

const db = vi.hoisted(() => ({
  snapshot: null as unknown,
  events: [] as unknown[],
  recorded: [] as { event: { type: string }; idempotencyKey: string; expectedVersion: number }[],
  conflicts: 0,
}));

vi.mock("@/lib/adapters/supabase", async (orig) => {
  const real = await orig<typeof import("@/lib/adapters/supabase")>();
  return {
    ...real,
    loadSnapshot: async (id: string) => {
      if (!db.snapshot) throw new real.IncidentNotFound(id);
      return db.snapshot;
    },
    listEvents: async () => db.events,
    recordEvent: async (args: (typeof db.recorded)[number]) => {
      if (db.conflicts-- > 0) throw new real.VersionConflict("conflict");
      if (db.recorded.some((r) => r.idempotencyKey === args.idempotencyKey)) return args.expectedVersion; // replay, like record_event
      db.recorded.push(args);
      return args.expectedVersion + 1;
    },
  };
});

const { decide, decisionStatus, DecisionRefused } = await import("@/lib/services/decide");
const { POST } = await import("@/app/api/decide/route");
const { GDPR_MODULE_VERSION } = await import("@/lib/regulations/gdpr");

const ID = "00000000-0000-4000-8000-000000000001";
const confirmed = <T,>(value: T) => ({ value, state: "confirmed" as const, method: "human" as const, sources: [] });

// Controller, confidentiality breach of contact data, confirmed: Art. 33 notification firmly "required".
function snapshot(version = 3): IncidentSnapshot {
  return {
    id: ID,
    version,
    firstSignalAt: "2026-10-04T08:00:00Z",
    awarenessAt: "2026-10-04T09:00:00Z",
    severity: confirmed("major"),
    signalIds: [],
    facts: {
      personal_data: confirmed(true),
      processing_role: confirmed("controller"),
      breach_type: confirmed(["confidentiality"]),
      data_categories: confirmed(["contact"]),
      subjects_count: confirmed(2400),
      encrypted: confirmed(false),
    },
  };
}

const dpo = { role: "dpo" as const, name: "Claire Martin" };
const REASONS = "2,400 customer contacts exfiltrated via phishing; risk to the people concerned.";
const base = { incidentId: ID, obligationId: "gdpr.notify_authority" as const, choice: "notify" as const, reasons: REASONS, by: dpo };

beforeEach(() => {
  db.snapshot = snapshot();
  db.events = [];
  db.recorded = [];
  db.conflicts = 0;
});

describe("decide", () => {
  it("the fixture is firmly required (guards the override tests)", async () => {
    const { evaluate } = await import("@/lib/regulations/gdpr");
    const o = evaluate(snapshot()).obligations.find((x) => x.id === "gdpr.notify_authority")!;
    expect([o.status, o.factsToConfirm]).toEqual(["required", []]);
  });

  it("refuses a signer who is not the DPO", async () => {
    await expect(decide({ ...base, by: { role: "it", name: "Hugo" } })).rejects.toBeInstanceOf(DecisionRefused);
    expect(db.recorded).toHaveLength(0);
  });

  it("refuses short reasons", async () => {
    await expect(decide({ ...base, reasons: "  too short   " })).rejects.toBeInstanceOf(DecisionRefused);
    expect(db.recorded).toHaveLength(0);
  });

  it("refuses do_not_notify against a firm 'required' without override, records it with override", async () => {
    await expect(decide({ ...base, choice: "do_not_notify" })).rejects.toBeInstanceOf(DecisionRefused);
    expect(db.recorded).toHaveLength(0);
    const { event } = await decide({ ...base, choice: "do_not_notify", overrideRecommendation: true });
    expect(db.recorded).toHaveLength(1);
    expect(event.reasons).toMatch(/Recommendation overridden/);
  });

  it("records factsVersion and moduleVersion", async () => {
    await decide(base);
    expect(db.recorded[0].event).toMatchObject({ type: "decision", by: dpo, factsVersion: 3, moduleVersion: GDPR_MODULE_VERSION });
    expect(db.recorded[0].expectedVersion).toBe(3);
  });

  it("a double submit uses the same idempotency key, even though the first one bumped the version", async () => {
    const first = await decide(base);
    db.snapshot = snapshot(4);
    db.events = [{ id: 10, at: "2026-10-04T10:00:00Z", event: first.event }];
    const second = await decide(base);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(db.recorded).toHaveLength(1);
    expect(second).toMatchObject({ replayed: true, event: { factsVersion: 3 } }); // the stored decision, not the retry's
    // a fact change in between makes it a new decision
    db.events.push({ id: 11, at: "2026-10-04T10:01:00Z", event: { type: "answer", by: dpo, factKey: "encrypted", answer: "no", via: "web" } });
    expect((await decide(base)).idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("retries once on a version conflict, then gives up", async () => {
    db.conflicts = 1;
    await decide(base);
    expect(db.recorded).toHaveLength(1);
    db.conflicts = 2;
    await expect(decide(base)).rejects.toThrow("conflict");
  });
});

describe("decisionStatus", () => {
  const decision = (id: number): LoggedEvent => ({
    id,
    at: "2026-10-04T10:00:00Z",
    event: { type: "decision", by: dpo, obligationId: "gdpr.notify_authority", choice: "notify", reasons: REASONS, factsVersion: 3, moduleVersion: "x" },
  });
  const answer = (id: number): LoggedEvent => ({
    id,
    at: "2026-10-04T10:05:00Z",
    event: { type: "answer", by: dpo, factKey: "encrypted", answer: "no", via: "web" },
  });
  const draft = (id: number): LoggedEvent => ({ id, at: "2026-10-04T10:05:00Z", event: { type: "draft", document: "breach_register", status: "draft" } });

  it("is current when no fact changed after the decision", () => {
    expect(decisionStatus([answer(1), decision(2), draft(3)]).map((d) => d.status)).toEqual(["current"]);
  });
  it("is to_re_evaluate after a later answer", () => {
    expect(decisionStatus([decision(1), answer(2)]).map((d) => d.status)).toEqual(["to_re_evaluate"]);
  });
  it("a new decision after the change is current again", () => {
    expect(decisionStatus([decision(1), answer(2), decision(3)]).map((d) => [d.eventId, d.status])).toEqual([[3, "current"]]);
  });
});

describe("POST /api/decide", () => {
  const post = (body: unknown, cookie = "demo_key=k") =>
    POST(new Request("http://localhost/api/decide", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  beforeEach(() => vi.stubEnv("DEMO_KEY", "k"));

  it("401 without the demo key", async () => expect((await post(base, "")).status).toBe(401));
  it("400 on a bad body", async () => expect((await post({ ...base, obligationId: "gdpr.record_breach" })).status).toBe(400));
  it("404 on an unknown incident", async () => {
    db.snapshot = null;
    expect((await post(base)).status).toBe(404);
  });
  it("422 when refused, 201 when recorded", async () => {
    expect((await post({ ...base, by: { role: "it", name: "Hugo" } })).status).toBe(422);
    expect((await post(base)).status).toBe(201);
  });
});
