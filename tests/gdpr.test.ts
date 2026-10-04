import { describe, expect, it } from "vitest";
import { GdprModule } from "@/lib/regulations/gdpr";
import { ENCRYPTION_OK, NUVOLA, run, snap } from "./helpers/gdpr";

const C = "confirmed";
const HIGH = { ...NUVOLA, data_categories: ["financial"] };

describe("GDPR evaluate: Nuvola demo", () => {
  it("all facts proposed: authority required with facts to confirm, subjects for the lawyer, record required", () => {
    const { a, by } = run(NUVOLA);
    expect(a.applicability).toBe("applicable");
    expect(a.moduleVersion).toBe("1.0.0");
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").factsToConfirm).toEqual(expect.arrayContaining(["personal_data", "encrypted"]));
    expect(by("notify_authority").deadline).toEqual({ policy: "duration", startEvent: "awareness", hours: 72 });
    expect(by("notify_authority").blockingQuestions).toContain("records_count");
    expect(by("inform_subjects").status).toBe("undetermined");
    expect(by("inform_subjects").deadline).toEqual({ policy: "without_undue_delay", startEvent: "awareness" });
    expect(by("record_breach").status).toBe("required");
    expect(by("notify_controller").status).toBe("undetermined"); // controller only proposed
  });

  it("all facts confirmed: authority required with nothing left to confirm", () => {
    const { by } = run(NUVOLA, C);
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").factsToConfirm).toEqual([]);
    expect(by("notify_controller").status).toBe("not_required");
  });
});

describe("Art. 33 tree step 1: personal data unknown → treated as yes", () => {
  it("missing, null, proposed false or disputed: applicable, everything required with personal_data to confirm", () => {
    const { personal_data: _omit, ...rest } = NUVOLA;
    void _omit;
    for (const input of [rest, { ...rest, personal_data: null }, { ...rest, personal_data: false }, { ...rest, personal_data: [true, "disputed"] }]) {
      const { a, by } = run(input);
      expect(a.applicability).toBe("applicable");
      for (const id of ["notify_authority", "record_breach"]) {
        expect(by(id).status).toBe("required");
        expect(by(id).factsToConfirm).toContain("personal_data");
        expect(by(id).blockingQuestions).toContain("personal_data");
      }
      expect(by("notify_authority").reasons.join(" ")).toMatch(/treated as yes/);
    }
  });

  it("personal_data confirmed false: not a breach, nothing required, logged as a security incident", () => {
    const { a } = run({ personal_data: [false, C] });
    expect(a.applicability).toBe("not_applicable");
    expect(a.obligations).toHaveLength(4);
    for (const o of a.obligations) {
      expect(o.status).toBe("not_required");
      expect(o.reasons.join(" ")).toMatch(/security incident/);
    }
  });
});

describe("Q6: encryption exception, four conditions confirmed by IT", () => {
  it("all four conditions + backup confirmed: authority and subjects not required, record still required", () => {
    const { by } = run({ ...NUVOLA, ...ENCRYPTION_OK });
    expect(by("notify_authority").status).toBe("not_required");
    expect(by("inform_subjects").status).toBe("not_required");
    expect(by("record_breach").status).toBe("required");
  });

  it.each(Object.keys(ENCRYPTION_OK))("%s missing, only proposed, or false: no exception", (key) => {
    for (const variant of [undefined, [true, "proposed"], [false, C], [true, "disputed"]]) {
      const input: Record<string, unknown> = { ...HIGH, ...ENCRYPTION_OK, [key]: variant };
      if (variant === undefined) delete input[key];
      const { by } = run(input);
      expect(by("notify_authority").status, `${key}=${JSON.stringify(variant)}`).toBe("required");
      expect(by("inform_subjects").status, `${key}=${JSON.stringify(variant)}`).toBe("required");
    }
  });

  it("encrypted + keys safe alone (old rule) is no longer enough", () => {
    const { by } = run({ ...NUVOLA, encrypted: [true, C], keys_safe: [true, C] });
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").blockingQuestions).toEqual(
      expect.arrayContaining(["encryption_state_of_art", "encryption_covers_copies", "backup_exists"]),
    );
    expect(by("inform_subjects").status).not.toBe("not_required");
  });

  it("the backup condition is waived only once IT confirmed no data was lost", () => {
    const { backup_exists: _b, ...noBackup } = ENCRYPTION_OK;
    void _b;
    expect(run({ ...NUVOLA, ...noBackup, breach_type: [["confidentiality"], C] }).by("notify_authority").status).toBe("not_required");
    expect(run({ ...NUVOLA, ...noBackup, breach_type: [["confidentiality"], "proposed"] }).by("notify_authority").status).toBe("required");
    expect(run({ ...NUVOLA, ...noBackup, breach_type: [["confidentiality", "availability"], C] }).by("notify_authority").status).toBe("required");
  });

  it("a key known to be compromised stops asking the other encryption questions", () => {
    const { by } = run({ ...NUVOLA, encrypted: [true, C], keys_safe: [false, C] });
    expect(by("notify_authority").blockingQuestions).not.toContain("encryption_state_of_art");
  });

  it("harm already reaching people overrides the exception", () => {
    const { by } = run({ ...NUVOLA, ...ENCRYPTION_OK, people_affected: true });
    expect(by("notify_authority").status).toBe("required");
    expect(by("inform_subjects").status).toBe("required");
    expect(by("inform_subjects").factsToConfirm).toContain("people_affected");
  });
});

describe("Q1: Art. 34(3)(b), risk removed by action, not by promises", () => {
  it("access ended AND no data left control, both confirmed: subjects not required", () => {
    const o = run({ ...HIGH, still_exposed: [false, C], data_left_control: [false, C] }).by("inform_subjects");
    expect(o.status).toBe("not_required");
    expect(o.citedFacts.sort()).toEqual(["data_left_control", "still_exposed"]);
  });

  it("'the attacker no longer has access' alone is not enough", () => {
    const o = run({ ...HIGH, still_exposed: [false, C] }).by("inform_subjects");
    expect(o.status).toBe("required");
    expect(o.blockingQuestions).toContain("data_left_control");
  });

  it("data left control: exception only when every copy is confirmed recovered or destroyed", () => {
    const left = { ...HIGH, still_exposed: [false, C], data_left_control: [true, C] };
    expect(run({ ...left, copies_recovered: [true, C] }).by("inform_subjects").status).toBe("not_required");
    expect(run({ ...left, copies_recovered: [true, "proposed"] }).by("inform_subjects").status).toBe("required");
    expect(run({ ...left, copies_recovered: [false, C] }).by("inform_subjects").status).toBe("required");
    expect(run(left).by("inform_subjects").blockingQuestions).toContain("copies_recovered");
  });

  it("only proposed, or access not ended: no exception", () => {
    expect(run({ ...HIGH, still_exposed: false, data_left_control: false }).by("inform_subjects").status).toBe("required");
    expect(run({ ...HIGH, still_exposed: [true, C], data_left_control: [false, C] }).by("inform_subjects").status).toBe("required");
  });

  it("Art. 33: a contained mistake is not notifiable, a contained attack is", () => {
    const contained = { ...NUVOLA, still_exposed: [false, C], data_left_control: [false, C] };
    expect(run({ ...contained, malicious: [false, C] }, C).by("notify_authority").status).toBe("not_required");
    expect(run({ ...contained, malicious: [true, C] }, C).by("notify_authority").status).toBe("required");
    expect(run({ ...contained, malicious: [false, "proposed"] }, C).by("notify_authority").status).toBe("required");
    expect(run(contained, C).by("notify_authority").blockingQuestions).toContain("malicious");
  });
});

describe("Q2: availability-only breach", () => {
  const AVAIL = { ...NUVOLA, breach_type: [["availability"], C] };

  it("availability only and restored in good time, both confirmed: not required, documented", () => {
    const { by } = run({ ...AVAIL, availability_restored: [true, C] });
    expect(by("notify_authority").status).toBe("not_required");
    expect(by("notify_authority").citedFacts.sort()).toEqual(["availability_restored", "breach_type"]);
    expect(by("inform_subjects").status).toBe("not_required");
  });

  it("restoration unknown or only proposed: notify, and ask whether it was restored", () => {
    expect(run(AVAIL).by("notify_authority").status).toBe("required");
    expect(run(AVAIL).by("notify_authority").blockingQuestions).toContain("availability_restored");
    expect(run({ ...AVAIL, availability_restored: true }).by("notify_authority").status).toBe("required");
  });

  it("not availability-only until confirmed: proposed, or also confidentiality → notify", () => {
    expect(run({ ...AVAIL, breach_type: ["availability"], availability_restored: [true, C] }).by("notify_authority").status).toBe("required");
    expect(
      run({ ...AVAIL, breach_type: [["availability", "confidentiality"], C], availability_restored: [true, C] }).by("notify_authority").status,
    ).toBe("required");
  });

  it("permanent loss (no usable backup): risk presumed, notify", () => {
    const o = run({ ...AVAIL, backup_exists: [false, C], availability_restored: [true, C] }).by("notify_authority");
    expect(o.status).toBe("required");
    expect(o.reasons.join(" ")).toMatch(/permanent loss/);
  });
});

describe("Q3/Q4 and the Art. 33(2) tree: processor", () => {
  const PROC = { ...NUVOLA, processing_role: ["processor", C] };

  it("confirmed processor: inform the client; authority and register are the client's duty, subjects the client's decision", () => {
    const { by } = run(PROC);
    expect(by("notify_controller").status).toBe("required");
    expect(by("notify_controller").reasons.join(" ")).toMatch(/phases/);
    expect(by("notify_authority").status).toBe("controller_duty");
    expect(by("notify_authority").blockingQuestions).toEqual(["contract_mandate"]);
    expect(by("inform_subjects").status).toBe("controller_decides");
    expect(by("record_breach").status).toBe("controller_duty");
  });

  it("no risk check for the processor: the client is informed even when Q6 holds", () => {
    expect(run({ ...PROC, ...ENCRYPTION_OK }).by("notify_controller").status).toBe("required");
  });

  it("contract authorises us: prepare, send only on the client's instruction", () => {
    const o = run({ ...PROC, contract_mandate: [true, C] }).by("notify_authority");
    expect(o.blockingQuestions).toEqual([]);
    expect(o.reasons.join(" ")).toMatch(/only on the client's instruction/);
  });

  it("processor only proposed: the client is informed AND our own duties stay", () => {
    const { by } = run({ ...NUVOLA, processing_role: "processor" });
    expect(by("notify_controller").status).toBe("required");
    expect(by("notify_controller").factsToConfirm).toContain("processing_role");
    expect(by("notify_authority").status).toBe("required");
    expect(by("record_breach").status).toBe("required");
    expect(by("inform_subjects").status).not.toBe("controller_decides");
  });
});

describe("Q5 and the Art. 34 tree: high risk", () => {
  it("presumed for sensitive data, children, or harm already reaching people", () => {
    for (const input of [HIGH, { ...NUVOLA, subjects_categories: ["minors"] }, { ...NUVOLA, people_affected: true }])
      expect(run(input).by("inform_subjects").status).toBe("required");
    expect(run({ ...NUVOLA, subjects_categories: ["minors"] }).by("inform_subjects").factsToConfirm).toContain("subjects_categories");
  });

  it("data kind unknown → treated as yes, with the fact to confirm", () => {
    const o = run({ ...NUVOLA, data_categories: null }).by("inform_subjects");
    expect(o.status).toBe("required");
    expect(o.factsToConfirm).toContain("data_categories");
  });

  it("no presumption: the lawyer decides, with the aggravating factors", () => {
    const o = run({ ...NUVOLA, malicious: true }).by("inform_subjects");
    expect(o.status).toBe("undetermined");
    expect(o.reasons.join(" ")).toMatch(/lawyer/);
    expect(o.reasons.join(" ")).toMatch(/Aggravating factors.*2400 people concerned.*deliberate attack.*data seen or taken/);
    expect(o.blockingQuestions).toEqual(expect.arrayContaining(["subjects_categories", "people_affected"]));
  });

  it("cannot contact each person (confirmed): public announcement instead of direct messages", () => {
    for (const input of [HIGH, NUVOLA]) {
      const o = run({ ...input, can_contact_individually: [false, C] }).by("inform_subjects");
      expect(o.reasons.join(" ")).toMatch(/public announcement instead of direct messages/);
    }
    expect(run({ ...HIGH, can_contact_individually: false }).by("inform_subjects").reasons.join(" ")).not.toMatch(/public announcement/);
  });
});

// Every value a fact can take in the sweep: absent, proposed, confirmed, disputed.
const B = [undefined, [true, "proposed"], [true, C], [false, "proposed"], [false, C]];
const all = (keys: string[], value: unknown) => Object.fromEntries(keys.map((k) => [k, value]));

describe("asymmetry (R08): nothing lifts a duty on an unconfirmed fact", () => {
  it("property: across all combinations, no not_required / controller_duty / controller_decides rests on an unconfirmed fact", () => {
    const dims: Record<string, unknown[]> = {
      personal_data: [...B, [true, "disputed"]],
      processing_role: [undefined, ["controller", C], ["processor", "proposed"], ["processor", C]],
      breach_type: [undefined, [["confidentiality"], C], [["availability"], C], [["availability"], "proposed"]],
      // Q6 bundles: none, all confirmed, one proposed, key compromised
      enc: [{}, ENCRYPTION_OK, { ...ENCRYPTION_OK, keys_safe: [true, "proposed"] }, { ...ENCRYPTION_OK, keys_safe: [false, C] }],
      // Q1 bundles: (malicious, still_exposed, data_left_control, copies_recovered)
      q1: [
        {},
        all(["still_exposed", "data_left_control"], [false, C]),
        { malicious: [false, C], ...all(["still_exposed", "data_left_control"], [false, C]) },
        { malicious: [false, "proposed"], ...all(["still_exposed", "data_left_control"], [false, C]) },
        { still_exposed: [false, C], data_left_control: [false, "proposed"] },
        { still_exposed: [false, C], data_left_control: [true, C], copies_recovered: [true, C] },
        { still_exposed: [false, C], data_left_control: [true, "proposed"], copies_recovered: [true, "proposed"] },
      ],
      availability_restored: [undefined, [true, C], [true, "proposed"]],
      people_affected: [undefined, [true, "proposed"], [false, C]],
      data_categories: [undefined, [["contact"], C], [["financial"], "proposed"]],
    };
    const keys = Object.keys(dims);
    const seen: Record<string, number> = {};
    let count = 0;
    const visit = (i: number, acc: Record<string, unknown>) => {
      if (i < keys.length) {
        for (const v of dims[keys[i]]) visit(i + 1, keys[i] === "enc" || keys[i] === "q1" ? { ...acc, ...(v as object) } : { ...acc, [keys[i]]: v });
        return;
      }
      const s = snap(Object.fromEntries(Object.entries(acc).filter(([, v]) => v !== undefined)));
      count++;
      for (const o of GdprModule.evaluate(s).obligations) {
        seen[o.status] = (seen[o.status] ?? 0) + 1;
        if (o.status === "required") {
          for (const k of o.factsToConfirm) if (s.facts[k]?.state === C) throw new Error(`${o.id}: confirmed ${k} listed to confirm`);
          continue;
        }
        if (o.factsToConfirm.length) throw new Error(`${o.id} ${o.status} with facts to confirm`);
        if (o.status === "undetermined") continue;
        if (!o.citedFacts.length) throw new Error(`${o.id} ${o.status} cites nothing`);
        for (const k of o.citedFacts)
          if (s.facts[k]?.state !== C) throw new Error(`${o.id} ${o.status} cites unconfirmed ${k}: ${JSON.stringify(acc)}`);
      }
    };
    visit(0, {});
    expect(count).toBe(6 * 4 * 4 * 4 * 7 * 3 * 3 * 3);
    // The property is not vacuous: every lifting status is reached.
    for (const st of ["not_required", "controller_duty", "controller_decides", "undetermined", "required"]) expect(seen[st], st).toBeGreaterThan(0);
  });

  it("a disputed fact counts as unknown", () => {
    const { by } = run({ ...NUVOLA, ...ENCRYPTION_OK, encrypted: [true, "disputed"] });
    expect(by("notify_authority").status).toBe("required");
    expect(by("notify_authority").citedFacts).not.toContain("encrypted");
    expect(by("inform_subjects").status).not.toBe("not_required");
  });
});
