import { describe, expect, it } from "vitest";
import { latestBrief, toEventRows } from "@/lib/dashboard/view";

const by = { role: "dpo" as const, name: "Cécile" };

describe("listEvents() rows -> dashboard events", () => {
  it("flattens the event and keeps the awareness time from the payload", () => {
    const [row] = toEventRows([
      { id: 7, at: "2026-10-04T13:30:00.000Z", actor: "Cécile", event: { type: "awareness", by, at: "2026-10-04T13:21:00.000Z", previousAt: null } },
    ]);
    expect(row).toMatchObject({ id: 7, actor: "Cécile", type: "awareness", at: "2026-10-04T13:21:00.000Z" });
  });

  it("takes the brief of the latest extraction that produced one", () => {
    const extraction = (id: number, brief: string | null = null) => ({
      id,
      at: "2026-10-04T12:56:12.000Z",
      actor: "core",
      event: { type: "extraction" as const, status: "ok" as const, provenance: "m", recordedDemo: false, factKeys: [], brief },
    });
    expect(latestBrief(toEventRows([extraction(1, "premier"), extraction(2, "second"), extraction(3)]))).toBe("second");
    expect(latestBrief([])).toBeNull();
  });
});
