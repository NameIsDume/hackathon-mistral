import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { IncidentSnapshot } from "@/lib/domain";

const ID = "22222222-2222-4222-8222-222222222222";
const loadSnapshot = vi.fn();
const recordEvent = vi.fn();
vi.mock("@/lib/adapters/supabase", async (orig) => {
  const real = await orig<typeof import("@/lib/adapters/supabase")>();
  return { ...real, loadSnapshot: (id: string) => loadSnapshot(id), recordEvent: (a: unknown) => recordEvent(a) };
});
const { VersionConflict, IncidentNotFound } = await import("@/lib/adapters/supabase");
const { confirmSeverity, setAwareness, InvalidAwareness } = await import("@/lib/services/review");
const severityRoute = await import("@/app/api/severity/route");
const awarenessRoute = await import("@/app/api/awareness/route");
const assessmentRoute = await import("@/app/api/assessment/route");

const snap = (over: Partial<IncidentSnapshot> = {}): IncidentSnapshot => ({
  id: ID,
  version: 4,
  firstSignalAt: "2026-10-04T07:00:00.000Z",
  awarenessAt: null,
  severity: { value: "average", state: "proposed", method: "llm", sources: [{ excerpt: "CRM export" }] },
  signalIds: [],
  facts: { personal_data: { value: true, state: "proposed", method: "llm", sources: [] } },
  ...over,
});
const alex = { role: "it" as const, name: "Alex" };

beforeEach(() => {
  loadSnapshot.mockReset().mockResolvedValue(snap());
  recordEvent.mockReset().mockResolvedValue(5);
});

describe("confirmSeverity", () => {
  it("writes the confirmed fact and an event carrying the previous value", async () => {
    await confirmSeverity(ID, "major", alex);
    const a = recordEvent.mock.calls[0][0];
    expect(a.expectedVersion).toBe(4);
    expect(a.event).toEqual({ type: "severity_confirmed", by: alex, value: "major", previous: "average" });
    expect(a.facts.severity).toMatchObject({ value: "major", state: "confirmed", method: "human", sources: [], confirmedBy: "Alex" });
    expect(a.facts.personal_data.value).toBe(true); // other facts kept
  });

  it("reloads and retries once on a version conflict, then gives up", async () => {
    loadSnapshot.mockResolvedValueOnce(snap()).mockResolvedValueOnce(snap({ version: 5 }));
    recordEvent.mockRejectedValueOnce(new VersionConflict("x")).mockResolvedValueOnce(6);
    await expect(confirmSeverity(ID, "major", alex)).resolves.toBe(6);
    expect(recordEvent.mock.calls.map(([a]) => a.expectedVersion)).toEqual([4, 5]);

    recordEvent.mockReset().mockRejectedValue(new VersionConflict("x"));
    await expect(confirmSeverity(ID, "major", alex)).rejects.toBeInstanceOf(VersionConflict);
    expect(recordEvent).toHaveBeenCalledTimes(2);
  });
});

describe("setAwareness", () => {
  it("rejects a future time and a time before the first signal", async () => {
    await expect(setAwareness(ID, new Date(Date.now() + 3_600_000).toISOString(), alex)).rejects.toBeInstanceOf(InvalidAwareness);
    await expect(setAwareness(ID, "2026-10-04T06:59:00.000Z", alex)).rejects.toBeInstanceOf(InvalidAwareness);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("records the awareness time, and a correction keeps the previous one", async () => {
    await setAwareness(ID, "2026-10-04T07:40:00.000Z", alex);
    loadSnapshot.mockResolvedValue(snap({ version: 5, awarenessAt: "2026-10-04T07:40:00.000Z" }));
    await setAwareness(ID, "2026-10-04T07:10:00+00:00", alex);
    const [first, second] = recordEvent.mock.calls.map(([a]) => a);
    expect(first).toMatchObject({ awarenessAt: "2026-10-04T07:40:00.000Z", event: { type: "awareness", previousAt: null } });
    expect(second).toMatchObject({
      awarenessAt: "2026-10-04T07:10:00+00:00",
      event: { type: "awareness", at: "2026-10-04T07:10:00+00:00", previousAt: "2026-10-04T07:40:00.000Z" },
    });
    expect(second.facts).toBeUndefined(); // facts untouched
  });
});

const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, cookie = "demo_key=k") =>
  route.POST(new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));

describe.each([
  ["severity", severityRoute, { incidentId: ID, value: "major", by: alex }],
  ["awareness", awarenessRoute, { incidentId: ID, at: "2026-10-04T07:40:00Z", by: alex }],
])("POST /api/%s", (_, route, body) => {
  beforeEach(() => vi.stubEnv("DEMO_KEY", "k"));

  it("401 without the demo key, 400 on an invalid body, 404 on an unknown incident, 409 on a lasting conflict", async () => {
    expect((await post(route, body, "")).status).toBe(401);
    expect((await post(route, { ...body, by: { role: "ceo", name: "" } })).status).toBe(400);
    expect((await post(route, body)).status).toBe(200);
    loadSnapshot.mockRejectedValue(new IncidentNotFound(ID));
    expect((await post(route, body)).status).toBe(404);
    loadSnapshot.mockResolvedValue(snap());
    recordEvent.mockRejectedValue(new VersionConflict("x"));
    expect((await post(route, body)).status).toBe(409);
  });
});

it("POST /api/awareness answers 400 for a time before the first signal", async () => {
  vi.stubEnv("DEMO_KEY", "k");
  expect((await post(awarenessRoute, { incidentId: ID, at: "2026-10-01T00:00:00Z", by: alex })).status).toBe(400);
});

describe("GET /api/assessment", () => {
  const getNext = (q: string) => assessmentRoute.GET(new NextRequest(`http://localhost/api/assessment?${q}`));

  it("returns obligations and a 72 h clock, provisional while awareness is unknown", async () => {
    const res = await getNext(`incidentId=${ID}`);
    const body = await res.json();
    expect(body.assessment.obligations.length).toBeGreaterThan(0);
    expect(body.clocks["gdpr.notify_authority"]).toMatchObject({ dueAt: "2026-10-07T07:00:00.000Z", provisional: true });

    loadSnapshot.mockResolvedValue(snap({ awarenessAt: "2026-10-04T07:40:00.000Z" }));
    const after = await (await getNext(`incidentId=${ID}`)).json();
    expect(after.clocks["gdpr.notify_authority"]).toMatchObject({ dueAt: "2026-10-07T07:40:00.000Z", provisional: false });
  });

  it("400 on a bad id, 404 on an unknown incident", async () => {
    expect((await getNext("incidentId=nope")).status).toBe(400);
    loadSnapshot.mockRejectedValue(new IncidentNotFound(ID));
    expect((await getNext(`incidentId=${ID}`)).status).toBe(404);
  });
});
