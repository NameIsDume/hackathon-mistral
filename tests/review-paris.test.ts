import { describe, expect, it } from "vitest";
import { parisLocalToIso, toParisLocal } from "@/components/review/shared";

describe("Paris wall-clock <-> UTC (awareness input)", () => {
  it("converts summer and winter times", () => {
    expect(parisLocalToIso("2026-10-04T09:40")).toBe("2026-10-04T07:40:00.000Z");
    expect(parisLocalToIso("2026-12-01T00:10")).toBe("2026-11-30T23:10:00.000Z");
    expect(toParisLocal("2026-10-04T07:40:00.000Z")).toBe("2026-10-04T09:40");
  });

  it("handles the 25/10/2026 winter change", () => {
    expect(parisLocalToIso("2026-10-25T01:30")).toBe("2026-10-24T23:30:00.000Z");
    expect(parisLocalToIso("2026-10-25T03:30")).toBe("2026-10-25T02:30:00.000Z");
    expect(toParisLocal(parisLocalToIso("2026-10-25T02:30"))).toBe("2026-10-25T02:30");
  });
});
