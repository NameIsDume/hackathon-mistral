import { describe, expect, it } from "vitest";
import { IncidentSnapshot, Role, Signal, fact } from "@/lib/domain";
import { GDPR_FACTS, GDPR_QUESTIONS, GdprFactValues } from "@/lib/regulations/gdpr/facts";
import { z } from "zod";

const signal = {
  id: "7bdfbd1d-57aa-42bb-8623-66a331d04e7b",
  workspaceId: "demo",
  connectorId: "demo",
  externalId: "msg-1",
  occurredAt: "2026-10-04T09:12:00+02:00",
  receivedAt: "2026-10-04T07:12:01Z",
  actor: "sales@nuvola.example",
  content: "I think I clicked a phishing link.",
  sourceRef: {},
};

describe("Signal", () => {
  it("accepts the demo message", () => expect(Signal.parse(signal)).toBeTruthy());
  it("rejects content over 4000 characters", () =>
    expect(Signal.safeParse({ ...signal, content: "x".repeat(4001) }).success).toBe(false));
});

describe("Fact", () => {
  const encrypted = fact(z.boolean());
  it("keeps unknown (null) distinct from false", () => {
    expect(encrypted.parse({ value: null, state: "proposed", method: "llm", sources: [] }).value).toBeNull();
    expect(encrypted.parse({ value: false, state: "proposed", method: "llm", sources: [] }).value).toBe(false);
  });
  it("rejects an unknown state", () =>
    expect(encrypted.safeParse({ value: true, state: "maybe", method: "llm", sources: [] }).success).toBe(false));
});

describe("IncidentSnapshot", () => {
  it("parses a snapshot with proposed severity and no awareness yet", () =>
    expect(
      IncidentSnapshot.parse({
        id: signal.id,
        version: 1,
        firstSignalAt: signal.occurredAt,
        awarenessAt: null,
        severity: { value: "average", state: "proposed", method: "llm", sources: [] },
        signalIds: [signal.id],
        facts: { personal_data: { value: true, state: "proposed", method: "llm", sources: [{ excerpt: "client exports" }] } },
      }),
    ).toBeTruthy());
});

describe("GDPR fact catalogue", () => {
  it("has one question per fact, each routed to a known role", () => {
    expect(GDPR_QUESTIONS).toHaveLength(Object.keys(GDPR_FACTS).length);
    for (const q of GDPR_QUESTIONS) expect(Role.safeParse(q.role).success).toBe(true);
  });
  it("accepts an all-unknown extraction and the Nuvola facts", () => {
    const unknown = Object.fromEntries(Object.keys(GDPR_FACTS).map((k) => [k, null]));
    expect(GdprFactValues.parse(unknown)).toBeTruthy();
    expect(
      GdprFactValues.parse({
        ...unknown,
        personal_data: true,
        breach_type: ["confidentiality"],
        data_categories: ["contact"],
        subjects_count: 2400,
        encrypted: false,
        processing_role: "controller",
      }),
    ).toBeTruthy();
  });
  it("rejects a value outside the schema", () => {
    const unknown = Object.fromEntries(Object.keys(GDPR_FACTS).map((k) => [k, null]));
    expect(GdprFactValues.safeParse({ ...unknown, processing_role: "owner" }).success).toBe(false);
  });
});
