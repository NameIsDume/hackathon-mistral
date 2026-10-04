import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyWave = vi.fn();
vi.mock("@/lib/services/notify", async (orig) => ({ ...(await orig<object>()), notifyWave: (...a: unknown[]) => notifyWave(...a) }));
const confirmSeverity = vi.fn();
vi.mock("@/lib/services/review", () => ({ confirmSeverity: (...a: unknown[]) => confirmSeverity(...a) }));

const { afterIntake, afterSeverityChange, confirmSeverityAndNotify } = await import("@/lib/services/triggers");
const ID = "22222222-2222-4222-8222-222222222222";
const created = { status: "created", incidentId: ID, provenance: null, recordedDemo: false, brief: null } as const;

beforeEach(() => notifyWave.mockReset().mockResolvedValue([]));
const roles = () => notifyWave.mock.calls.map((c) => c[2]);

describe("afterSeverityChange", () => {
  it("average -> major notifies management only", async () => {
    await afterSeverityChange(ID, "average", "major");
    expect(roles()).toEqual([["management"]]);
  });
  it("unknown (= average wave) -> major notifies management only", async () => {
    await afterSeverityChange(ID, null, "major");
    expect(roles()).toEqual([["management"]]);
  });
  it("major -> average and an unchanged value notify nobody", async () => {
    await afterSeverityChange(ID, "major", "average");
    await afterSeverityChange(ID, "average", "average");
    expect(notifyWave).not.toHaveBeenCalled();
  });
  it("confirmSeverityAndNotify uses the value the confirmation replaced", async () => {
    confirmSeverity.mockResolvedValue({ version: 7, previous: "minimal" });
    expect(await confirmSeverityAndNotify(ID, "average", { role: "dpo", name: "Claire" })).toBe(7);
    expect(roles()).toEqual([["lawyer", "business_owner"]]);
  });
});

describe("afterIntake", () => {
  it("sends the whole wave for an incident (classification failure fails open)", async () => {
    await afterIntake({ ...created, isIncident: true, extraction: "ok" });
    await afterIntake({ ...created, isIncident: null, extraction: "ok" });
    expect(roles()).toEqual([undefined, undefined]);
  });
  it("only acknowledges the reporter for a non-incident or an unavailable extraction", async () => {
    await afterIntake({ ...created, isIncident: false, extraction: "skipped" });
    await afterIntake({ ...created, isIncident: true, extraction: "unavailable" });
    expect(roles()).toEqual([["reporter"], ["reporter"]]);
  });
  it("sends nothing on a replay", async () => {
    await afterIntake({ status: "replayed", incidentId: ID });
    expect(notifyWave).not.toHaveBeenCalled();
  });
});
