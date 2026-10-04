// Integration of #48 (Q13 "I don't know" marker, "defer" choice) with #47 (rules) and #49 (register).
import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/regulations/gdpr";
import { breachRegister, toMarkdown, type EventRow } from "@/lib/regulations/gdpr/templates";
import { snap } from "./helpers/gdpr";

describe("Q13: a fact answered \"I don't know\" is unknown for the rules", () => {
  it("a confirmed 'no personal data' no longer counts once someone says they don't know", () => {
    const s = snap({ personal_data: [false, "confirmed"] });
    expect(evaluate(s).applicability).toBe("not_applicable");
    s.facts.personal_data = { ...s.facts.personal_data, dontKnowBy: "Hugo", dontKnowAt: "2026-10-04T10:00:00Z" };
    expect(evaluate(s).applicability).toBe("applicable"); // unknown is treated as yes (Martyna's Art. 33 tree)
  });
});

describe("register shows a deferred decision as deferred", () => {
  it("never renders 'defer' as 'Do not notify'", () => {
    const s = snap({ personal_data: true, breach_type: ["confidentiality"] });
    const at = "2026-10-04T10:30:00+00:00";
    const by = { role: "lawyer" as const, name: "Martyna" };
    const events: EventRow[] = [
      { at, actor: "slack", event: { type: "decision", stage: "decision", by, obligationId: "gdpr.notify_authority", choice: "defer", reasons: "Waiting for forensics on the copies.", factsVersion: 1, moduleVersion: "1.0.0" } as never },
    ];
    const md = toMarkdown(breachRegister(s, evaluate(s), events));
    expect(md).toContain("Defer pending facts");
    expect(md).not.toContain("Do not notify");
    expect(md).not.toContain("Decision to notify;");
  });
});
