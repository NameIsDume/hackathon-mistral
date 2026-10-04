import { describe, expect, it } from "vitest";
import { Assessment, type IncidentSnapshot } from "@/lib/domain";
import { GdprModule } from "@/lib/regulations/gdpr";

type State = "proposed" | "confirmed" | "disputed";
const STATES: unknown[] = ["proposed", "confirmed", "disputed"];
// A bare value is a fact in the default state; [value, state] sets the state explicitly.
type Input = Record<string, unknown>;

function snap(input: Input, defaultState: State = "proposed"): IncidentSnapshot {
  const facts: IncidentSnapshot["facts"] = {};
  for (const [k, raw] of Object.entries(input)) {
    const [value, state] =
      Array.isArray(raw) && raw.length === 2 && STATES.includes(raw[1]) ? (raw as [unknown, State]) : [raw, defaultState];
    facts[k] = { value, state, method: state === "confirmed" ? "human" : "llm", sources: [] };
  }
  return {
    id: "7bdfbd1d-57aa-42bb-8623-66a331d04e7b",
    version: 1,
    firstSignalAt: "2026-10-04T09:12:00+02:00",
    awarenessAt: null,
    severity: { value: null, state: "proposed", method: "llm", sources: [] },
    signalIds: [],
    facts,
  };
}

const run = (input: Input, state?: State) => {
  const a = Assessment.parse(GdprModule.evaluate(snap(input, state)));
  const by = (id: string) => a.obligations.find((o) => o.id === `gdpr.${id}`)!;
  return { a, by };
};

const NUVOLA = {
  personal_data: true,
  breach_type: ["confidentiality"],
  data_categories: ["contact"],
  subjects_count: 2400,
  encrypted: false,
  processing_role: "controller",
};

describe("GDPR evaluate: Nuvola demo", () => {
  it("all facts proposed: authority required with facts to confirm, subjects undetermined, record required", () => {
    const { a, by } = run(NUVOLA);
    expect(a.applicability).toBe("applicable");
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").factsToConfirm).toEqual(expect.arrayContaining(["personal_data", "encrypted"]));
    expect(by("notify_authority").deadline).toEqual({ policy: "duration", startEvent: "awareness", hours: 72 });
    expect(by("inform_subjects").status).toBe("undetermined");
    expect(by("inform_subjects").reasons.join(" ")).toMatch(/lawyer/);
    expect(by("inform_subjects").deadline).toEqual({ policy: "without_undue_delay", startEvent: "awareness" });
    expect(by("record_breach").status).toBe("required");
    expect(by("notify_controller").status).toBe("undetermined"); // controller only proposed
  });

  it("all facts confirmed: authority required with nothing left to confirm", () => {
    const { by } = run(NUVOLA, "confirmed");
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").factsToConfirm).toEqual([]);
    expect(by("notify_controller").status).toBe("not_required");
  });
});

describe("GDPR evaluate: asymmetry (R08)", () => {
  it("encrypted + keys safe only proposed never yields not_required", () => {
    const { by } = run({ ...NUVOLA, encrypted: true, keys_safe: true });
    for (const id of ["inform_subjects", "notify_authority"]) expect(by(id).status).not.toBe("not_required");
    expect(by("notify_authority").factsToConfirm).toEqual(expect.arrayContaining(["encrypted", "keys_safe"]));
  });

  it("encryption confirmed but key compromised: no exception", () => {
    const { by } = run({ ...NUVOLA, encrypted: [true, "confirmed"], keys_safe: [false, "confirmed"] });
    expect(by("notify_authority").status).toBe("required");
    expect(by("inform_subjects").status).not.toBe("not_required");
  });

  it("encryption alone (key status unknown) is not an exception", () => {
    const { by } = run({ ...NUVOLA, encrypted: [true, "confirmed"] });
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").blockingQuestions).toContain("keys_safe");
    expect(by("inform_subjects").status).not.toBe("not_required");
  });

  it("encrypted and keys safe both confirmed: both not_required", () => {
    const { by } = run({ ...NUVOLA, encrypted: [true, "confirmed"], keys_safe: [true, "confirmed"] });
    expect(by("notify_authority").status).toBe("not_required");
    expect(by("inform_subjects").status).toBe("not_required");
    expect(by("record_breach").status).toBe("required");
  });

  it("still_exposed confirmed false: Art. 34(3)(b) exception; proposed false is not enough", () => {
    const high = { ...NUVOLA, data_categories: ["financial"] };
    expect(run({ ...high, still_exposed: [false, "confirmed"] }).by("inform_subjects").status).toBe("not_required");
    expect(run({ ...high, still_exposed: false }).by("inform_subjects").status).toBe("required");
  });

  it("property: across all combinations, no not_required rests on an unconfirmed cited fact", () => {
    const bool = [undefined, [true, "proposed"], [true, "confirmed"], [false, "proposed"], [false, "confirmed"], [true, "disputed"]];
    const role = [undefined, ["controller", "proposed"], ["controller", "confirmed"], ["processor", "proposed"], ["processor", "confirmed"]];
    const cats = [undefined, [["contact"], "proposed"], [["financial"], "proposed"], [["financial"], "confirmed"]];
    const subj = [undefined, [["minors"], "proposed"]];
    let count = 0;
    let notRequired = 0;
    for (const personal_data of bool)
      for (const encrypted of bool)
        for (const keys_safe of bool)
          for (const still_exposed of bool)
            for (const processing_role of role)
              for (const data_categories of cats)
                for (const subjects_categories of subj) {
                  const all = { personal_data, encrypted, keys_safe, still_exposed, processing_role, data_categories, subjects_categories };
                  const s = snap(Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)));
                  count++;
                  for (const o of GdprModule.evaluate(s).obligations) {
                    if (o.status === "not_required") {
                      notRequired++;
                      expect(o.citedFacts.length).toBeGreaterThan(0);
                      for (const k of o.citedFacts) expect(s.facts[k]?.state, `${o.id} cites ${k}`).toBe("confirmed");
                    }
                    if (o.status === "required") for (const k of o.factsToConfirm) expect(s.facts[k]?.state).not.toBe("confirmed");
                  }
                }
    expect(count).toBe(6 ** 4 * 5 * 4 * 2);
    expect(notRequired).toBeGreaterThan(0); // the property is not vacuous
  });
});

describe("GDPR evaluate: roles and applicability", () => {
  it("processor confirmed: inform the controller, authority is the controller's job", () => {
    const { by } = run({ ...NUVOLA, processing_role: ["processor", "confirmed"] });
    expect(by("notify_controller").status).toBe("required");
    expect(by("notify_controller").deadline?.policy).toBe("without_undue_delay");
    expect(by("notify_authority").status).toBe("not_required");
  });

  it("processor only proposed: controller notice required, authority not dismissed", () => {
    const { by } = run({ ...NUVOLA, processing_role: "processor" });
    expect(by("notify_controller").status).toBe("required");
    expect(by("notify_controller").factsToConfirm).toContain("processing_role");
    expect(by("notify_authority").status).toBe("required");
  });

  it("personal_data confirmed false: not applicable, nothing required", () => {
    const { a } = run({ personal_data: [false, "confirmed"] });
    expect(a.applicability).toBe("not_applicable");
    expect(a.obligations).toHaveLength(4);
    for (const o of a.obligations) expect(o.status).toBe("not_required");
  });

  it("personal_data unknown (missing, null, or only proposed false): undetermined everywhere", () => {
    const { personal_data: _omit, ...rest } = NUVOLA;
    void _omit;
    for (const input of [rest, { ...rest, personal_data: null }, { ...rest, personal_data: false }]) {
      const { a } = run(input);
      expect(a.applicability).toBe("unknown");
      for (const o of a.obligations) {
        expect(o.status).toBe("undetermined");
        expect(o.blockingQuestions).toEqual(["personal_data"]);
      }
    }
  });

  it("a disputed fact counts as unknown", () => {
    expect(run({ ...NUVOLA, personal_data: [true, "disputed"] }).a.applicability).toBe("unknown");
    const { by } = run({ ...NUVOLA, encrypted: [true, "disputed"], keys_safe: [true, "confirmed"] });
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").citedFacts).not.toContain("encrypted");
    expect(by("inform_subjects").status).not.toBe("not_required");
  });

  it("high risk (financial data) or minors: inform subjects required", () => {
    expect(run({ ...NUVOLA, data_categories: ["contact", "financial"] }).by("inform_subjects").status).toBe("required");
    const minors = run({ ...NUVOLA, subjects_categories: ["minors"] }).by("inform_subjects");
    expect(minors.status).toBe("required");
    expect(minors.factsToConfirm).toContain("subjects_categories");
  });
});
