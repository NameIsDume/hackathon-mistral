import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { IncidentSnapshot } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { MISSING, breachRegister, cnilNotification, toMarkdown, type EventRow } from "@/lib/regulations/gdpr/templates";

const h = vi.hoisted(() => ({ narrative: "" }));
vi.mock("@ai-sdk/mistral", () => ({
  mistral: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ narrative: h.narrative }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    }),
}));
import { draftNarrative } from "@/lib/adapters/mistral";

type Raw = Record<string, [unknown, "proposed" | "confirmed"]>;
const NUVOLA: Raw = {
  personal_data: [true, "confirmed"],
  breach_type: [["confidentiality"], "confirmed"],
  data_categories: [["contact"], "confirmed"],
  subjects_count: [2400, "proposed"],
  encrypted: [false, "confirmed"],
  processing_role: ["controller", "confirmed"],
};
const AWARE = "2026-10-04T10:00:00+02:00";
const snap = (raw: Raw, awarenessAt: string | null = AWARE): IncidentSnapshot => ({
  id: "7bdfbd1d-57aa-42bb-8623-66a331d04e7b",
  version: 3,
  firstSignalAt: "2026-10-04T09:12:00+02:00",
  awarenessAt,
  severity: { value: null, state: "proposed", method: "llm", sources: [] },
  signalIds: [],
  facts: Object.fromEntries(
    Object.entries(raw).map(([k, [value, state]]) => [k, { value, state, method: state === "confirmed" ? "human" : "llm", sources: [] }]),
  ),
});
const SOON = new Date("2026-10-05T10:00:00+02:00"); // 24 h after awareness
const LATE = new Date("2026-10-08T10:00:00+02:00"); // 96 h after awareness
const cnil = (s: IncidentSnapshot, now = SOON, events: EventRow[] = []) => cnilNotification(s, evaluate(s), events, {}, now);
const field = (doc: ReturnType<typeof cnil>, heading: string, label: string) =>
  doc.sections.find((s) => s.heading.startsWith(heading))!.fields.find((f) => f.label === label)!;

describe("CNIL notification draft", () => {
  it("Nuvola: four Art. 33(3) sections, DPO unknown, proposed facts flagged", () => {
    const doc = cnil(snap(NUVOLA));
    for (const h of ["(a)", "(b)", "(c)", "(d)"]) expect(doc.sections.some((s) => s.heading.startsWith(h))).toBe(true);
    expect(field(doc, "(b)", "Name and contact details")).toMatchObject({ value: MISSING, missing: true });
    expect(field(doc, "(a)", "Approximate number of data subjects")).toMatchObject({
      value: "approximately 2400 (to be confirmed)",
      missing: false,
      sourceFact: "subjects_count",
    });
    expect(field(doc, "(a)", "Categories of personal data concerned")).toMatchObject({ value: "contact", missing: false });
    expect(field(doc, "(c)", "Data encrypted").value).toBe("No");
  });

  it("invents nothing: with every fact unknown, every fact field is 'Unknown, to be completed'", () => {
    const doc = cnil(snap({}, null));
    const factFields = doc.sections.flatMap((s) => s.fields).filter((f) => f.sourceFact);
    expect(factFields.length).toBeGreaterThan(5);
    for (const f of factFields) expect(f).toMatchObject({ value: MISSING, missing: true });
    // Same for disputed facts.
    const disputed = snap({});
    disputed.facts.subjects_count = { value: 2400, state: "disputed", method: "llm", sources: [] };
    expect(field(cnil(disputed), "(a)", "Approximate number of data subjects").value).toBe(MISSING);
  });

  it("reasons for delay appear only when the 72-hour clock is overdue", () => {
    const has = (now: Date) => cnil(snap(NUVOLA), now).sections.some((s) => s.heading.startsWith("Reasons for the delay"));
    expect(has(SOON)).toBe(false);
    expect(has(LATE)).toBe(true);
    expect(field(cnil(snap(NUVOLA), LATE), "Reasons for the delay", "Reasons for notifying after 72 hours").missing).toBe(true);
  });

  it("markdown export contains every section heading and writes unknowns out", () => {
    const doc = cnil(snap(NUVOLA), LATE);
    const md = toMarkdown(doc);
    for (const s of doc.sections) expect(md).toContain(`## ${s.heading}`);
    expect(md).toContain(MISSING);
    const reg = breachRegister(snap(NUVOLA), evaluate(snap(NUVOLA)), []);
    for (const s of reg.sections) expect(toMarkdown(reg)).toContain(`## ${s.heading}`);
  });
});

describe("breach register (Art. 33(5))", () => {
  const dpo = { role: "dpo" as const, name: "Camille Martin" };
  const events: EventRow[] = [
    { at: "2026-10-04T10:05:00+02:00", actor: "dpo", event: { type: "awareness", by: dpo, at: AWARE, previousAt: null } },
    {
      at: "2026-10-04T11:00:00+02:00",
      actor: "dpo",
      event: {
        type: "decision",
        by: dpo,
        obligationId: "gdpr.notify_authority",
        choice: "do_not_notify",
        reasons: "Exposure limited to an internal share, no access by a third party.",
        factsVersion: 3,
        moduleVersion: "0.1.0-provisional",
      },
    },
  ];

  it("a do_not_notify decision is recorded with its reasons and who decided", () => {
    const s = snap(NUVOLA);
    const doc = breachRegister(s, evaluate(s), events);
    const decision = doc.sections.find((x) => x.heading === "Decisions and reasons")!.fields.find((f) => f.label.startsWith("Decision:"))!;
    expect(decision.value).toContain("Do not notify");
    expect(decision.value).toContain("Exposure limited to an internal share");
    expect(decision.value).toContain("Camille Martin (dpo)");
    expect(doc.sections.find((x) => x.heading === "Notification to the authority")!.fields[0].value).toMatch(/^No: decision not to notify/);
    const timeline = doc.sections.find((x) => x.heading === "Timeline")!.fields.map((f) => f.label);
    expect(timeline).toEqual(["First signal", expect.stringContaining("Awareness set"), expect.stringContaining("Decision on gdpr.notify_authority")]);
  });

  it("without a decision, the decision and notification status are 'to be completed'", () => {
    const s = snap(NUVOLA);
    const doc = breachRegister(s, evaluate(s), []);
    expect(doc.sections.find((x) => x.heading === "Notification to the authority")!.fields[0]).toMatchObject({ missing: true, value: MISSING });
  });
});

describe("draftNarrative", () => {
  const facts = snap(NUVOLA).facts;
  it("keeps a narrative whose numbers all come from the facts", async () => {
    h.narrative = "Contact details of about 2,400 people (to be confirmed) were exposed.";
    expect(await draftNarrative("nature", facts)).toBe(h.narrative);
  });
  it("drops a narrative citing a number not in the facts", async () => {
    h.narrative = "Contact details of about 3,000 people were exposed.";
    expect(await draftNarrative("nature", facts)).toBeNull();
  });
});
