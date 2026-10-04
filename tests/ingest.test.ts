import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal fake of the supabase-js query builder: each table call returns the next queued result.
const queue: { error: { code?: string; message: string } | null; data?: unknown }[] = [];
const builder = () => {
  const b: Record<string, unknown> = {};
  for (const m of ["insert", "select", "update", "eq"]) b[m] = () => b;
  b.single = async () => queue.shift();
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(queue.shift()).then(res);
  return b;
};
const recordEvent = vi.fn();
vi.mock("@/lib/adapters/supabase", () => ({ db: () => ({ from: () => builder() }), recordEvent: (a: unknown) => recordEvent(a) }));
const intake = vi.fn();
vi.mock("@/lib/adapters/mistral", () => ({ MODELS: { classify: "ministral-8b-2512" }, intake: (t: string) => intake(t) }));

const { ingestSignal } = await import("@/lib/services/ingest");
const { POST } = await import("@/app/api/intake/route");

const fact = (value: unknown) => ({ value, state: "proposed", method: "llm", sources: value === null ? [] : [{ excerpt: "x" }] });
const okExtraction = {
  status: "ok",
  provenance: "mistral-medium-2604",
  recordedDemo: false,
  brief: "Phishing, CRM exports gone.",
  severity: fact("average"),
  facts: { personal_data: fact(true), encrypted: fact(null) },
};

beforeEach(() => {
  queue.length = 0;
  recordEvent.mockReset();
  let v = 1;
  recordEvent.mockImplementation(async () => ++v);
  intake.mockReset();
});

const newSignal = () =>
  queue.push(
    { error: null, data: { id: "11111111-1111-4111-8111-111111111111" } }, // signals insert
    { error: null, data: { id: "22222222-2222-4222-8222-222222222222" } }, // incidents insert
    { error: null }, // signals update (link)
  );

describe("ingestSignal", () => {
  it("creates the incident and records signal, classification, extraction with facts", async () => {
    newSignal();
    intake.mockResolvedValue({ classification: { isIncident: true, reason: "phishing" }, extraction: okExtraction });
    const r = await ingestSignal({ text: "I clicked a phishing link", externalId: "m1" });

    expect(r).toMatchObject({ status: "created", extraction: "ok", brief: "Phishing, CRM exports gone." });
    const calls = recordEvent.mock.calls.map(([a]) => a);
    expect(calls.map((a) => a.event.type)).toEqual(["signal", "classification", "extraction"]);
    expect(calls.map((a) => a.expectedVersion)).toEqual([1, 2, 3]); // version chain, no lost update
    expect(calls[2].facts.severity.value).toBe("average");
    expect(calls[2].event.factKeys).toEqual(["personal_data"]); // unknown facts are not listed
  });

  it("does nothing on a replay of the same message id", async () => {
    queue.push({ error: { code: "23505", message: "duplicate" } }, { error: null, data: { incident_id: "inc-1" } });
    const r = await ingestSignal({ text: "same", externalId: "m1" });
    expect(r).toEqual({ status: "replayed", incidentId: "inc-1" });
    expect(intake).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("keeps the signal but writes no facts when extraction is unavailable", async () => {
    newSignal();
    intake.mockResolvedValue({ classification: null, extraction: { status: "unavailable", provenance: null, reason: "429", facts: {} } });
    const r = await ingestSignal({ text: "something odd" });
    const calls = recordEvent.mock.calls.map(([a]) => a);
    expect(r).toMatchObject({ status: "created", extraction: "unavailable", isIncident: null });
    expect(calls[1].event.isIncident).toBe(true); // fail open: kept for review
    expect(calls[2].facts).toBeUndefined();
  });

  it("records a non-incident without extraction", async () => {
    newSignal();
    intake.mockResolvedValue({ classification: { isIncident: false, reason: "sales talk" }, extraction: null });
    const r = await ingestSignal({ text: "our sales are a disaster" });
    expect(r).toMatchObject({ status: "created", isIncident: false, extraction: "skipped" });
    expect(recordEvent.mock.calls.map(([a]) => a.event.type)).toEqual(["signal", "classification"]);
  });
});

describe("POST /api/intake", () => {
  const req = (body: unknown, cookie?: string) =>
    new Request("http://localhost/api/intake", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  beforeEach(() => vi.stubEnv("DEMO_KEY", "k"));

  it("refuses without the demo key", async () => expect((await POST(req({ text: "x" }))).status).toBe(401));
  it("rejects an empty or oversized message", async () => {
    expect((await POST(req({ text: "" }, "demo_key=k"))).status).toBe(400);
    expect((await POST(req({ text: "x".repeat(4001) }, "demo_key=k"))).status).toBe(400);
  });
  it("returns 201 for a new incident", async () => {
    newSignal();
    intake.mockResolvedValue({ classification: { isIncident: true, reason: "r" }, extraction: okExtraction });
    expect((await POST(req({ text: "phishing" }, "demo_key=k"))).status).toBe(201);
  });
});
