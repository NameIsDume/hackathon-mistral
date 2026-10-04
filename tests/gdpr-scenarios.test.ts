// The lawyers' 7 test scenarios (docs/legal/decisions-2026-10-04.md, "Test scenarios"), expected outcomes verbatim:
// "lawyer decides" = undetermined; "required by the client" = controller_duty; "client decides" = controller_decides;
// "required in the client's register" = controller_duty.
import { describe, expect, it } from "vitest";
import { ENCRYPTION_OK, NUVOLA, run, type Input, type State } from "./helpers/gdpr";

const C = "confirmed";
const LAPTOP = {
  personal_data: [true, C],
  breach_type: [["confidentiality", "availability"], C],
  processing_role: ["controller", C],
};

type Row = {
  name: string;
  input: Input;
  state?: State;
  authority: string;
  subjects: string;
  register: string;
  controller?: string;
};

const SCENARIOS: Row[] = [
  // Demo as extracted by the AI: nothing confirmed yet.
  { name: "Demo: Nuvola phishing (AI-proposed facts)", input: NUVOLA, authority: "required", subjects: "undetermined", register: "required" },
  { name: "Demo: Nuvola phishing (facts confirmed)", input: NUVOLA, state: C, authority: "required", subjects: "undetermined", register: "required" },
  {
    name: "High risk: health or bank data, unencrypted",
    input: { ...NUVOLA, data_categories: ["special_category", "financial"], malicious: true },
    state: C,
    authority: "required",
    subjects: "required",
    register: "required",
  },
  {
    name: "Low risk: e-mail to wrong internal colleague, deleted",
    input: {
      personal_data: true,
      breach_type: ["confidentiality"],
      data_categories: ["contact"],
      subjects_categories: ["employees"],
      processing_role: "controller",
      malicious: false,
      still_exposed: false,
      data_left_control: false,
    },
    state: C,
    authority: "not_required",
    subjects: "not_required",
    register: "required",
  },
  { name: "Encrypted laptop lost, keys safe", input: { ...LAPTOP, ...ENCRYPTION_OK }, authority: "not_required", subjects: "not_required", register: "required" },
  {
    name: "Encrypted, password on a sticky note in the bag",
    input: { ...LAPTOP, ...ENCRYPTION_OK, keys_safe: [false, C] },
    authority: "required",
    subjects: "required",
    register: "required",
  },
  {
    name: "Nuvola as processor for a client's data",
    input: { ...NUVOLA, processing_role: "processor" },
    state: C,
    authority: "controller_duty",
    subjects: "controller_decides",
    register: "controller_duty",
    controller: "required",
  },
  {
    name: "No breach: phishing click, nothing accessed",
    input: { personal_data: [false, C], malicious: [true, C], processing_role: ["controller", C] },
    authority: "not_required",
    subjects: "not_required",
    register: "not_required",
  },
];

describe("lawyers' scenarios (decisions 2026-10-04)", () => {
  it.each(SCENARIOS)("$name", ({ input, state, authority, subjects, register, controller }) => {
    const { by } = run(input, state);
    expect({
      authority: by("notify_authority").status,
      subjects: by("inform_subjects").status,
      register: by("record_breach").status,
      ...(controller && { controller: by("notify_controller").status }),
    }).toEqual({ authority, subjects, register, ...(controller && { controller }) });
  });

  it("demo: the lawyer gets the aggravating factors to weigh", () => {
    const reasons = run({ ...NUVOLA, malicious: true }).by("inform_subjects").reasons.join(" ");
    expect(reasons).toMatch(/lawyer/);
    expect(reasons).toMatch(/2400 people concerned/);
    expect(reasons).toMatch(/deliberate attack/);
    expect(reasons).toMatch(/data seen or taken/);
  });

  it("sticky note: informing people is precautionary (data kind unknown → treated as yes), with facts to confirm", () => {
    const o = run({ ...LAPTOP, ...ENCRYPTION_OK, keys_safe: [false, C] }).by("inform_subjects");
    expect(o.factsToConfirm).toEqual(["data_categories"]);
    expect(o.reasons.join(" ")).toMatch(/precautionary/);
  });

  it("processor: Nuvola informs the client immediately and keeps its own incident log", () => {
    const { by } = run({ ...NUVOLA, processing_role: "processor" }, C);
    expect(by("notify_controller").deadline).toEqual({ policy: "without_undue_delay", startEvent: "awareness" });
    expect(by("notify_controller").factsToConfirm).toEqual([]);
    expect(by("record_breach").reasons.join(" ")).toMatch(/Nuvola keeps its own incident log/);
  });

  it("no breach: logged as a security incident", () => {
    const { a, by } = run({ personal_data: [false, C] });
    expect(a.applicability).toBe("not_applicable");
    expect(by("record_breach").reasons.join(" ")).toMatch(/security incident/);
  });
});
