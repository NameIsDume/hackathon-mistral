import { describe, expect, it } from "vitest";
import { deadline, formatParis } from "@/lib/clocks";

const H72 = { policy: "duration", startEvent: "awareness", hours: 72 } as const;
const firstSignalAt = "2026-10-04T09:12:00+02:00";

describe("clocks (R05)", () => {
  it("before awareness: provisional estimate from the first signal", () => {
    const c = deadline(H72, { firstSignalAt, awarenessAt: null }, new Date("2026-10-04T08:00:00Z"));
    expect(c).toMatchObject({ provisional: true, dueAt: "2026-10-07T07:12:00.000Z", overdue: false });
  });

  it("72 h from awareness", () => {
    const c = deadline(H72, { firstSignalAt, awarenessAt: "2026-10-04T09:40:00+02:00" }, new Date("2026-10-04T08:00:00Z"));
    expect(c).toMatchObject({ provisional: false, dueAt: "2026-10-07T07:40:00.000Z", remainingMs: 71 * 3_600_000 + 40 * 60_000 });
    expect(formatParis(c.dueAt!)).toContain("07/10/2026 09:40");
  });

  it("across the 25/10/2026 DST change: 72 h of elapsed time, 09:00 Paris", () => {
    const c = deadline(H72, { firstSignalAt, awarenessAt: "2026-10-24T10:00:00+02:00" }, new Date("2026-10-24T08:00:00Z"));
    expect(c.dueAt).toBe("2026-10-27T08:00:00.000Z");
    expect(formatParis(c.dueAt!)).toContain("27/10/2026 09:00");
  });

  it("overdue once now is past the due date", () => {
    const t = { firstSignalAt, awarenessAt: "2026-10-04T09:40:00+02:00" };
    expect(deadline(H72, t, new Date("2026-10-07T07:40:00Z"))).toMatchObject({ overdue: false, remainingMs: 0 });
    expect(deadline(H72, t, new Date("2026-10-07T07:40:01Z"))).toMatchObject({ overdue: true, remainingMs: -1000 });
  });

  it("without undue delay: no countdown", () => {
    const c = deadline({ policy: "without_undue_delay", startEvent: "awareness" }, { firstSignalAt, awarenessAt: null }, new Date());
    expect(c).toEqual({ dueAt: null, provisional: true, label: "without undue delay" });
  });
});
