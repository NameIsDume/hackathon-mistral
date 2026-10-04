import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { IncidentSnapshot } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import {
  MISSING,
  breachRegister,
  cnilNotification,
  draftState,
  subjectsNotice,
  toMarkdown,
  type EventRow,
} from "@/lib/regulations/gdpr/templates";

const h = vi.hoisted(() => ({ narrative: "", prompts: [] as string[] }));
vi.mock("@ai-sdk/mistral", () => ({
  mistral: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doGenerate: async (opts) => {
        h.prompts.push(JSON.stringify(opts.prompt));
        return {
          content: [{ type: "text", text: JSON.stringify({ narrative: h.narrative }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    }),
}));
import { draftNarrative } from "@/lib/adapters/mistral";

afterEach(() => vi.unstubAllEnvs());

type Raw = Record<string, [unknown, "proposed" | "confirmed"]>;
const NUVOLA: Raw = {
  personal_data: [true, "confirmed"],
  breach_type: [["confidentiality"], "confirmed"],
  data_categories: [["contact"], "confirmed"],
  subjects_count: [2400, "proposed"],
  encrypted: [false, "confirmed"],
  processing_role: ["controller", "confirmed"],
};
const ALL_CONFIRMED: Raw = {
  personal_data: [true, "confirmed"],
  breach_type: [["confidentiality"], "confirmed"],
  data_categories: [["contact"], "confirmed"],
  subjects_categories: [["customers"], "confirmed"],
  subjects_count: [2400, "confirmed"],
  records_count: [5000, "confirmed"],
  malicious: [true, "confirmed"],
  processing_role: ["controller", "confirmed"],
  encrypted: [false, "confirmed"],
  keys_safe: [false, "confirmed"],
  still_exposed: [false, "confirmed"],
  measures_taken: ["Access revoked", "confirmed"],
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
type Doc = ReturnType<typeof cnil>;
const field = (doc: Doc, heading: string, label: string) =>
  doc.sections.find((s) => s.heading.startsWith(heading))!.fields.find((f) => f.label === label)!;

const lawyer = { role: "lawyer" as const, name: "Inès Haddad" };
const camille = { role: "dpo" as const, name: "Camille Martin" };
const LAWYER_CONSEQUENCES = "Customers may receive targeted phishing emails.";
const LAWYER_MEASURES = "Access was revoked. We propose to warn customers by email.";
const aiDraft: EventRow = {
  at: "2026-10-04T11:30:00+02:00",
  actor: "system",
  event: { type: "draft", document: "cnil_notification", status: "draft", ai: { consequences: "AI consequences.", measures: "AI measures." } },
};
const approvals: EventRow[] = (
  [
    ["consequences", LAWYER_CONSEQUENCES],
    ["measures", LAWYER_MEASURES],
  ] as const
).map(([section, text]) => ({
  at: "2026-10-04T12:00:00+02:00",
  actor: "slack:U_LAW",
  event: { type: "draft", document: "cnil_notification", status: "section_approved", section, text, by: lawyer },
}));
const sent = (sentAt: string, reference?: string): EventRow => ({
  at: sentAt,
  actor: "slack:U_DPO",
  event: { type: "draft", document: "cnil_notification", status: "sent", sentAt, by: camille, ...(reference && { reference }) },
});
const notifyDecision: EventRow = {
  at: "2026-10-04T11:00:00+02:00",
  actor: "dpo",
  event: {
    type: "decision",
    by: camille,
    obligationId: "gdpr.notify_authority",
    choice: "notify",
    reasons: "Contact data was exported by an attacker.",
    factsVersion: 3,
    moduleVersion: "0.1.0-provisional",
  },
};

describe("CNIL notification draft", () => {
  it("official Art. 33(3) labels, in order", () => {
    expect(cnil(snap(NUVOLA)).sections.map((s) => s.heading)).toEqual([
      "(a) Nature of the breach, and categories and approximate number of data subjects and of personal data records concerned",
      "(b) Name and contact details of the DPO or other contact point",
      "(c) Likely consequences of the breach",
      "(d) Measures taken or proposed, including mitigation",
      "Reasons for notifying more than 72 hours after becoming aware",
    ]);
  });

  it("internal review wording stays out of the notification body (Martyna)", () => {
    const doc = cnil(snap(NUVOLA));
    const body = JSON.stringify(doc.sections);
    expect(body).not.toMatch(/computed|facts to confirm|Recommendation/);
    expect(toMarkdown(doc).split("\n---\n")[1]).toContain("Internal review (not part of the notification)");
  });

  it("Nuvola: DPO unknown, proposed facts flagged", () => {
    const doc = cnil(snap(NUVOLA));
    expect(field(doc, "(b)", "Name and contact details")).toMatchObject({ value: MISSING, missing: true });
    expect(field(doc, "(a)", "Approximate number of data subjects")).toMatchObject({
      value: "approximately 2400 (to be confirmed)",
      missing: false,
      sourceFact: "subjects_count",
    });
    expect(field(doc, "(a)", "Categories of personal data concerned")).toMatchObject({ value: "contact", missing: false });
    expect(field(doc, "(c)", "Data encrypted").value).toBe("No");
  });

  it("records_count: confirmed, estimate, or unknown; never inferred from subjects_count", () => {
    const records = (raw: Raw) => field(cnil(snap(raw)), "(a)", "Approximate number of personal data records");
    expect(records({ ...NUVOLA, records_count: [5000, "confirmed"] })).toMatchObject({
      value: "approximately 5000",
      missing: false,
      sourceFact: "records_count",
    });
    expect(records({ ...NUVOLA, records_count: [5000, "proposed"] }).value).toBe("approximately 5000 (estimate)");
    expect(records(NUVOLA)).toMatchObject({ value: MISSING, missing: true }); // subjects_count is 2400: not reused
  });

  it("DPO contact comes from configuration (DPO_CONTACT), never invented", () => {
    vi.stubEnv("DPO_CONTACT", "Camille Martin <dpo@nuvola.example>");
    expect(field(cnil(snap(NUVOLA)), "(b)", "Name and contact details")).toMatchObject({ value: "Camille Martin <dpo@nuvola.example>", missing: false });
    vi.stubEnv("DPO_CONTACT", "");
    expect(field(cnil(snap(NUVOLA)), "(b)", "Name and contact details")).toMatchObject({ value: MISSING, missing: true });
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

  it("the delay field is always present: 'Not applicable' on time, to be completed when late", () => {
    const reasons = (now: Date, events: EventRow[] = []) =>
      field(cnil(snap(NUVOLA), now, events), "Reasons for notifying more than 72 hours after becoming aware", "Reasons");
    expect(reasons(SOON)).toMatchObject({ value: "Not applicable, notified within 72 hours of awareness", missing: false });
    expect(reasons(LATE)).toMatchObject({ value: MISSING, missing: true });
    // Sent within 72 h, read later: still on time. Sent after: late.
    expect(reasons(LATE, [...approvals, sent("2026-10-05T09:00:00+02:00")]).missing).toBe(false);
    expect(reasons(LATE, [...approvals, sent("2026-10-07T11:00:00+02:00")]).missing).toBe(true);
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

describe("lawyer sign-off (Cécile)", () => {
  const status = (events: EventRow[]) => cnil(snap(NUVOLA), SOON, events).internal!.fields.find((f) => f.label === "Status")!.value;

  it("not ready to send before the lawyer approved both sections", () => {
    expect(status([aiDraft])).toBe("Draft, not ready to send: awaiting the lawyer's approval of likely consequences and measures taken or proposed");
    expect(status([aiDraft, approvals[0]])).toBe("Draft, not ready to send: awaiting the lawyer's approval of measures taken or proposed");
    expect(draftState([aiDraft, approvals[0]]).readyToSend).toBe(false);
    expect(draftState([aiDraft, ...approvals]).readyToSend).toBe(true);
    expect(status([aiDraft, ...approvals])).toBe("Ready to send: likely consequences and measures approved by the lawyer");
  });

  it("keeps both the AI draft and the lawyer's final text; the draft shows AI text only labelled as such", () => {
    const st = draftState([aiDraft, ...approvals]);
    expect(st.ai).toEqual({ consequences: "AI consequences.", measures: "AI measures." });
    expect(st.approved.consequences?.text).toBe(LAWYER_CONSEQUENCES);
    expect(field(cnil(snap(NUVOLA), SOON, [aiDraft]), "(c)", "Likely consequences (AI draft, not approved by the lawyer)")).toMatchObject({
      value: "AI consequences.",
      proposed: true,
    });
    const after = cnil(snap(NUVOLA), SOON, [aiDraft, ...approvals]).sections.find((x) => x.heading.startsWith("(d)"))!.fields.at(-1)!;
    expect(after.value).toBe(LAWYER_MEASURES);
    expect(after.label).toMatch(/^Measures taken or proposed \(approved by Inès Haddad/);
  });
});

describe("dates", () => {
  it("are shown in Paris time, never as raw UTC", () => {
    const md = toMarkdown(cnil(snap(NUVOLA), LATE));
    expect(md).toContain("04/10/2026 09:12 (Paris)"); // first signal
    expect(md).toContain("07/10/2026 10:00 (Paris)"); // 72-hour deadline
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("breach register (Art. 33(5))", () => {
  const events: EventRow[] = [
    { at: "2026-10-04T10:05:00+02:00", actor: "dpo", event: { type: "awareness", by: camille, at: AWARE, previousAt: null } },
    {
      at: "2026-10-04T11:00:00+02:00",
      actor: "dpo",
      event: {
        type: "decision",
        by: camille,
        obligationId: "gdpr.notify_authority",
        choice: "do_not_notify",
        reasons: "Exposure limited to an internal share, no access by a third party.",
        factsVersion: 3,
        moduleVersion: "0.1.0-provisional",
      },
    },
  ];
  const reg = (raw: Raw, ev: EventRow[], now = SOON) => breachRegister(snap(raw), evaluate(snap(raw)), ev, now);
  const overdue = (doc: Doc) => doc.sections[0].fields.find((f) => f.label === "Overdue");

  it("a do_not_notify decision is recorded with its reasons and who decided, and is never overdue", () => {
    const doc = reg(NUVOLA, events, LATE);
    const decision = doc.sections.find((x) => x.heading === "Decision and reasons")!.fields.find((f) => f.label.startsWith("Decision:"))!;
    expect(decision.value).toContain("Do not notify");
    expect(decision.value).toContain("Exposure limited to an internal share");
    expect(decision.value).toContain("Camille Martin (dpo)");
    expect(field(doc, "Entry status", "Notification to the authority").value).toMatch(/^Not notified: decision not to notify/);
    expect(overdue(doc)).toBeUndefined();
    const timeline = doc.sections.find((x) => x.heading === "Timeline")!.fields.map((f) => f.label);
    expect(timeline).toEqual(["First signal", expect.stringContaining("Awareness set"), expect.stringContaining("Decision on gdpr.notify_authority")]);
  });

  it("without a decision, the decision is 'to be completed' and the transmission not recorded", () => {
    const doc = reg(NUVOLA, []);
    expect(field(doc, "Decision and reasons", "Decision: gdpr.notify_authority")).toMatchObject({ missing: true, value: MISSING });
    expect(field(doc, "Entry status", "Notification to the authority").value).toBe("No decision yet; transmission not recorded");
  });

  it("four labelled parts and a completion marker", () => {
    expect(reg(NUVOLA, []).sections.map((x) => x.heading)).toEqual(["Entry status", "Facts", "Effects", "Remedial action", "Decision and reasons", "Timeline"]);
    const completion = (raw: Raw, ev: EventRow[]) => field(reg(raw, ev), "Entry status", "Completion").value;
    expect(completion(NUVOLA, [])).toBe("0 of 4 sections complete");
    expect(completion(ALL_CONFIRMED, [notifyDecision, ...approvals])).toBe("4 of 4 sections complete");
    // records_count only estimated: Facts incomplete (a confirmed figure is required for the register).
    expect(completion({ ...ALL_CONFIRMED, records_count: [5000, "proposed"] }, [notifyDecision, ...approvals])).toBe("3 of 4 sections complete");
    // Without the lawyer's approval, Effects and Remedial action are incomplete.
    expect(completion(ALL_CONFIRMED, [notifyDecision, aiDraft])).toBe("2 of 4 sections complete");
  });

  it("effects and remedial action reuse the lawyer-approved wording, never the AI draft", () => {
    expect(JSON.stringify(reg(NUVOLA, [aiDraft]))).not.toContain("AI consequences");
    const doc = reg(NUVOLA, [aiDraft, ...approvals]);
    expect(doc.sections.find((x) => x.heading === "Effects")!.fields.at(-1)!.value).toBe(LAWYER_CONSEQUENCES);
    expect(doc.sections.find((x) => x.heading === "Remedial action")!.fields.at(-1)!.value).toBe(LAWYER_MEASURES);
  });

  it("an undetermined branch reads 'Undetermined, [fact] unconfirmed'", () => {
    const doc = reg({ personal_data: [true, "proposed"], processing_role: ["controller", "proposed"] }, []);
    expect(field(doc, "Decision and reasons", "Recommendation: gdpr.notify_controller").value).toMatch(/^Undetermined, processing_role unconfirmed/);
  });

  it("'sent' is distinct from the decision to notify; overdue after 72 h until a transmission is recorded", () => {
    expect(field(reg(NUVOLA, [notifyDecision]), "Entry status", "Notification to the authority").value).toBe(
      "Decision to notify; transmission not recorded",
    );
    expect(overdue(reg(NUVOLA, [notifyDecision], SOON))).toBeUndefined();
    expect(overdue(reg(NUVOLA, [notifyDecision], LATE))?.value).toBe(
      "Yes: transmission not recorded after the 72-hour deadline (07/10/2026 10:00 (Paris))",
    );
    expect(overdue(reg(NUVOLA, [], LATE))).toBeDefined(); // no decision either
    const withSent = reg(NUVOLA, [notifyDecision, ...approvals, sent("2026-10-07T11:00:00+02:00", "CNIL-2026-123")], LATE);
    expect(overdue(withSent)).toBeUndefined();
    expect(field(withSent, "Entry status", "Notification to the authority").value).toBe(
      "Sent on 07/10/2026 11:00 (Paris), CNIL reference CNIL-2026-123, recorded by Camille Martin",
    );
  });

  it("reads #48's split: a DPO recommendation is not a decision", () => {
    const rec = { ...notifyDecision, event: { ...notifyDecision.event, stage: "recommendation" } } as unknown as EventRow;
    const doc = reg(NUVOLA, [rec]);
    expect(field(doc, "Decision and reasons", "Decision: gdpr.notify_authority").missing).toBe(true);
    expect(field(doc, "Decision and reasons", "DPO recommendation: gdpr.notify_authority").value).toContain("Notify");
    const dec = { ...notifyDecision, event: { ...notifyDecision.event, stage: "decision", by: lawyer } } as unknown as EventRow;
    expect(field(reg(NUVOLA, [rec, dec]), "Decision and reasons", "Decision: gdpr.notify_authority").value).toContain("Inès Haddad (lawyer)");
  });
});

describe("notice to data subjects (Art. 34)", () => {
  const inform = (choice: "notify" | "do_not_notify", stage?: string): EventRow => ({
    at: "2026-10-04T12:00:00+02:00",
    actor: "lawyer",
    event: { ...notifyDecision.event, obligationId: "gdpr.inform_subjects", choice, by: lawyer, ...(stage && { stage }) } as EventRow["event"],
  });

  it("is generated only after the lawyer's decision to inform", () => {
    expect(subjectsNotice(snap(NUVOLA), [])).toBeNull();
    expect(subjectsNotice(snap(NUVOLA), [notifyDecision])).toBeNull(); // an Art. 33 decision is not an Art. 34 one
    expect(subjectsNotice(snap(NUVOLA), [inform("do_not_notify")])).toBeNull();
    expect(subjectsNotice(snap(NUVOLA), [inform("notify", "recommendation")])).toBeNull(); // DPO recommendation only
    expect(subjectsNotice(snap(NUVOLA), [inform("notify")])).not.toBeNull();
  });

  it("reuses the lawyer-approved wording verbatim and the DPO contact", () => {
    vi.stubEnv("DPO_CONTACT", "Camille Martin <dpo@nuvola.example>");
    const doc = subjectsNotice(snap(NUVOLA), [aiDraft, ...approvals, inform("notify")])!;
    expect(doc.sections.map((s) => s.heading)).toEqual(["What happened", "What this means for you", "What we are doing", "Who to contact"]);
    expect(doc.sections[1].fields[0].value).toBe(LAWYER_CONSEQUENCES);
    expect(doc.sections[2].fields[0].value).toBe(LAWYER_MEASURES);
    expect(doc.sections[3].fields[0].value).toBe("Camille Martin <dpo@nuvola.example>");
    expect(JSON.stringify(subjectsNotice(snap(NUVOLA), [aiDraft, inform("notify")]))).not.toContain("AI consequences"); // never the AI text
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
  it("the measures prompt forbids presenting a proposed measure as taken", async () => {
    h.narrative = "Access was revoked.";
    h.prompts.length = 0;
    await draftNarrative("measures", facts);
    expect(h.prompts[0]).toContain("never as done");
  });
});
