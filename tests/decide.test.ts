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
const lawyer = { role: "lawyer" as const, name: "Inès Haddad" };
const REASONS = { factsReliedOn: ["personal_data", "data_categories"], riskFactors: "2,400 customer contacts exfiltrated via phishing." };
const NOW = new Date("2026-10-04T12:00:00Z"); // 69 h before the 72 h deadline (awareness 09:00Z)
const base = {
  incidentId: ID,
  obligationId: "gdpr.notify_authority" as const,
  stage: "recommendation" as const,
  choice: "notify" as const,
  reasons: REASONS,
  by: dpo,
  now: NOW,
};
const NOT_NOTIFYING = { ...REASONS, exceptionRelied: "Art. 33(1) risk unlikely", evidence: "IT log of the export", freeText: "We judge the risk unlikely." };

beforeEach(() => {
  db.snapshot = snapshot();
  db.events = [];
  db.recorded = [];
  db.conflicts = 0;
});

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => expect.fail("expected a refusal"),
    (e) => {
      expect(e).toBeInstanceOf(DecisionRefused);
      return (e as InstanceType<typeof DecisionRefused>).field;
    },
  );

describe("decide", () => {
  it("the fixture is firmly required (guards the override tests)", async () => {
    const { evaluate } = await import("@/lib/regulations/gdpr");
    const o = evaluate(snapshot()).obligations.find((x) => x.id === "gdpr.notify_authority")!;
    expect([o.status, o.factsToConfirm]).toEqual(["required", []]);
  });

  it("Q9: only the DPO records a recommendation, only the lawyer signs the decision", async () => {
    await refusal(decide({ ...base, by: { role: "it", name: "Hugo" } }));
    await refusal(decide({ ...base, by: lawyer }));
    await refusal(decide({ ...base, stage: "decision", by: dpo }));
    expect(db.recorded).toHaveLength(0);
    await decide(base);
    await decide({ ...base, stage: "decision", by: lawyer });
    expect(db.recorded.map((r) => r.event)).toMatchObject([
      { type: "decision", stage: "recommendation", by: dpo },
      { type: "decision", stage: "decision", by: lawyer },
    ]);
  });

  it("Q10: notify needs the facts relied on and the risk factors, nothing more", async () => {
    expect(await refusal(decide({ ...base, reasons: { ...REASONS, factsReliedOn: [] } }))).toBe("factsReliedOn");
    expect(await refusal(decide({ ...base, reasons: { ...REASONS, riskFactors: "  " } }))).toBe("riskFactors");
    expect(await refusal(decide({ ...base, reasons: { ...REASONS, factsReliedOn: ["made_up"] } }))).toBe("factsReliedOn");
    const { event } = await decide(base);
    expect(event.structured).toEqual(REASONS);
    expect(event.reasons).toContain("Facts relied on: personal data involved, kind of information.");
  });

  it("Q10: do not notify needs the exception, its evidence and free text too", async () => {
    const dnn = { ...base, choice: "do_not_notify" as const, overrideRecommendation: true };
    expect(await refusal(decide({ ...dnn, reasons: REASONS }))).toBe("exceptionRelied");
    expect(await refusal(decide({ ...dnn, reasons: { ...NOT_NOTIFYING, evidence: "" } }))).toBe("evidence");
    expect(await refusal(decide({ ...dnn, reasons: { ...NOT_NOTIFYING, freeText: undefined } }))).toBe("freeText");
    expect(db.recorded).toHaveLength(0);
    await decide({ ...dnn, reasons: NOT_NOTIFYING });
    expect(db.recorded).toHaveLength(1);
  });

  it("Q10: past the 72 h deadline the reasons for the delay are mandatory", async () => {
    const late = new Date("2026-10-07T10:00:00Z");
    expect(await refusal(decide({ ...base, now: late }))).toBe("delayReason");
    await decide({ ...base, now: late, reasons: { ...REASONS, delayReason: "Facts confirmed late by IT." } });
    expect(db.recorded).toHaveLength(1);
  });

  it("Q7: do not notify on a firm 'required' needs an explicit override", async () => {
    const dnn = { ...base, choice: "do_not_notify" as const, reasons: NOT_NOTIFYING };
    expect(await refusal(decide(dnn))).toBe("override");
    const { event } = await decide({ ...dnn, overrideRecommendation: true });
    expect(event).toMatchObject({ override: true, reasons: expect.stringMatching(/Override/) });
  });

  it("Q7: do not notify while facts are only proposed (required, facts to confirm) also needs the override", async () => {
    const s = snapshot();
    s.facts.processing_role = { ...s.facts.processing_role, state: "proposed" };
    db.snapshot = s;
    expect(await refusal(decide({ ...base, choice: "do_not_notify", reasons: NOT_NOTIFYING }))).toBe("override");
  });

  it("Q7: no override needed for not_required on confirmed facts", async () => {
    const s = snapshot();
    s.facts.encrypted = confirmed(true);
    s.facts.keys_safe = confirmed(true);
    // Q6 (rules 1.0.0): all four encryption conditions confirmed
    s.facts.encryption_state_of_art = confirmed(true);
    s.facts.encryption_covers_copies = confirmed(true);
    s.facts.backup_exists = confirmed(true);
    db.snapshot = s;
    const { event } = await decide({ ...base, choice: "do_not_notify", reasons: NOT_NOTIFYING });
    expect(event.override).toBeUndefined();
  });

  it("Q7: defer pending facts is recorded and only needs to say what we wait for", async () => {
    expect(await refusal(decide({ ...base, choice: "defer", reasons: { factsReliedOn: [], riskFactors: "" } }))).toBe("freeText");
    const { event } = await decide({ ...base, choice: "defer", reasons: { factsReliedOn: [], riskFactors: "", freeText: "Waiting for IT on keys_safe." } });
    expect(event).toMatchObject({ stage: "recommendation", choice: "defer" });
  });

  it("Q8: notifying against 'not required' is flagged, never blocked; reasons asked in both cases, stronger flag for the people concerned", async () => {
    const s = snapshot();
    s.facts.encrypted = confirmed(true);
    s.facts.keys_safe = confirmed(true);
    // Q6 (rules 1.0.0): all four encryption conditions confirmed
    s.facts.encryption_state_of_art = confirmed(true);
    s.facts.encryption_covers_copies = confirmed(true);
    s.facts.backup_exists = confirmed(true);
    db.snapshot = s;
    // Authority: light flag, with a short reason (legal decisions Q8).
    expect(await refusal(decide(base))).toBe("freeText");
    const authority = await decide({ ...base, reasons: { ...REASONS, freeText: "Precaution." } });
    expect(authority.event.flag).toMatch(/^Flag:/);
    const subjects = { ...base, obligationId: "gdpr.inform_subjects" as const };
    expect(await refusal(decide(subjects))).toBe("freeText");
    const { event } = await decide({ ...subjects, reasons: { ...REASONS, freeText: "Customers asked to be told." } });
    expect(event.flag).toMatch(/^Strong flag/);
    expect(event.reasons).toContain("Strong flag");
  });

  it("no flag when notifying on 'required'", async () => {
    expect((await decide(base)).event.flag).toBeUndefined();
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
    // the lawyer's decision with the same content is a different record
    expect((await decide({ ...base, stage: "decision", by: lawyer })).idempotencyKey).not.toBe(first.idempotencyKey);
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
  const decision = (id: number, stage?: "recommendation" | "decision"): LoggedEvent => ({
    id,
    at: "2026-10-04T10:00:00Z",
    event: { type: "decision", ...(stage && { stage }), by: dpo, obligationId: "gdpr.notify_authority", choice: "notify", reasons: "r", factsVersion: 3, moduleVersion: "x" },
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
  it("keeps the recommendation and the decision apart, each current or to re-evaluate (a stage-less event is a decision)", () => {
    expect(decisionStatus([decision(1, "recommendation"), answer(2), decision(3)]).map((d) => [d.stage, d.status])).toEqual([
      ["recommendation", "to_re_evaluate"],
      ["decision", "current"],
    ]);
  });
});

describe("POST /api/decide", () => {
  const post = (body: unknown, cookie = "demo_key=k") =>
    POST(new Request("http://localhost/api/decide", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  const body = base; // `now` is not part of the API body: stripped
  beforeEach(() => vi.stubEnv("DEMO_KEY", "k"));

  it("401 without the demo key", async () => expect((await post(body, "")).status).toBe(401));
  it("400 on a bad body", async () => expect((await post({ ...body, obligationId: "gdpr.record_breach" })).status).toBe(400));
  it("404 on an unknown incident", async () => {
    db.snapshot = null;
    expect((await post(body)).status).toBe(404);
  });
  it("422 when refused, 201 when recorded", async () => {
    expect((await post({ ...body, by: { role: "it", name: "Hugo" } })).status).toBe(422);
    expect((await post(body)).status).toBe(201);
  });
});
