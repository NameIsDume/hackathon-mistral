import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS, GDPR_QUESTIONS } from "@/lib/regulations/gdpr/facts";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn(), listEvents: vi.fn(async () => []) }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({ ...(await orig<object>()), ...m }));

import { ROLE_MATRIX, WAVES, buildDm, notifyWave, waveFor } from "@/lib/services/notify";
import { SIGNERS, type DecisionStatus } from "@/lib/services/decide";

const now = new Date("2026-10-04T10:00:00+02:00");
type Dm = { blocks: Record<string, unknown>[] } | null;
const allActionIds = (dm: Dm) =>
  (dm?.blocks ?? []).flatMap((b) => [...((b.elements as { action_id: string }[]) ?? []), ...(b.accessory ? [b.accessory as { action_id: string }] : [])]).map((e) => e.action_id).filter(Boolean);
const actionsOf = (dm: Dm, blockId: string) => allActionIds({ blocks: (dm?.blocks ?? []).filter((b) => b.block_id === blockId) });
const dmFor = (role: Role, s = snap(NUVOLA), extra: { decisions?: DecisionStatus[]; reask?: string[]; now?: Date } = {}) => {
  const dm = buildDm(role, { snapshot: s, assessment: evaluate(s), brief: "Phishing on the CRM: 3 exports downloaded.", now, ...extra });
  return dm && { ...dm, all: dm.text + JSON.stringify(dm.blocks) };
};

describe("role scoping (Nuvola, severity average)", () => {
  it("IT gets its own questions with buttons and no legal reasoning", () => {
    const dm = dmFor("it")!;
    expect(dm.questionIds.sort()).toEqual([
      "gdpr.breach_type",
      "gdpr.data_left_control",
      "gdpr.encrypted",
      "gdpr.malicious",
      "gdpr.personal_data",
      "gdpr.still_exposed",
    ]);
    expect(dm.blocks.filter((b) => b.type === "actions").map((b) => b.block_id)).toEqual(expect.arrayContaining(["encrypted", "still_exposed"]));
    const a = evaluate(snap(NUVOLA));
    for (const o of a.obligations) for (const s of [...o.reasons, ...o.legalRefs, o.id]) expect(dm.all).not.toContain(s);
    expect(dm.all).not.toMatch(/GDPR|Art\.|required|CNIL|deadline/i);
  });

  it("AI-proposed facts get Confirm/Wrong with the value and excerpt; unknown booleans keep Yes/No/I don't know", () => {
    const dm = dmFor("it")!;
    expect(actionsOf(dm, "encrypted")).toEqual(["fact_confirm", "fact_wrong", "fact_dont_know"]);
    expect(actionsOf(dm, "breach_type")).toEqual(["fact_confirm", "fact_wrong", "fact_dont_know"]);
    expect(actionsOf(dm, "still_exposed")).toEqual(["answer_yes", "answer_no", "answer_unknown"]);
    expect(dm.all).toContain("The AI suggests: *No*");
    expect(dm.all).toContain("about encrypted");
  });

  it("Q13: a fact answered \"I don't know\" is not asked again, an AI proposal included (it stays proposed)", () => {
    const s = snap(NUVOLA);
    const dontKnow = { dontKnowBy: "Hugo", dontKnowAt: "2026-10-04T10:00:00Z" };
    s.facts.still_exposed = { value: null, state: "proposed", method: "human", sources: [], ...dontKnow };
    s.facts.encrypted = { ...s.facts.encrypted, ...dontKnow };
    const dm = dmFor("it", s)!;
    expect(dm.questionIds).not.toContain("gdpr.still_exposed");
    expect(dm.questionIds).not.toContain("gdpr.encrypted");
    expect(actionsOf(dm, "still_exposed")).toEqual([]);
    expect(dmFor("dpo", s)!.text).toContain(`encrypted: No — proposed by the AI, not confirmed; "I don't know" from Hugo`);
    // unless the lawyer asks for it again
    expect(dmFor("it", s, { reask: ["encrypted"] })!.questionIds).toContain("gdpr.encrypted");
  });

  it("non-boolean unknown or disputed facts get an Answer button", () => {
    expect(actionsOf(dmFor("business_owner")!, "subjects_categories")).toEqual(["fact_input", "fact_dont_know"]); // unknown, blocking
    const s = snap(NUVOLA);
    s.facts.processing_role.state = "disputed";
    const dm = dmFor("dpo", s)!;
    expect(actionsOf(dm, "processing_role")).toEqual(["fact_input", "fact_dont_know"]);
    expect(dm.all).toContain("was marked wrong");
  });

  it("Confirm/Wrong and Answer buttons only ever target facts the role owns", () => {
    for (const s of [snap(NUVOLA), snap({ personal_data: true }), snap({ ...NUVOLA, processing_role: "processor" })])
      for (const role of Role.options) {
        const dm = dmFor(role, s);
        for (const b of dm?.blocks ?? [])
          for (const e of (b.elements as { action_id: string; value?: string }[] | undefined) ?? [])
            if (/^(fact_|answer_)/.test(e.action_id)) expect(GDPR_FACTS[JSON.parse(e.value!).factKey as keyof typeof GDPR_FACTS].role, `${role} ${e.value}`).toBe(role);
      }
  });

  it("the DPO gets the assessment, the clock, its fact to confirm, the severity select, the datetimepicker and Sign buttons", () => {
    const dm = dmFor("dpo")!;
    expect(dm.questionIds).toEqual(["gdpr.processing_role"]);
    expect(dm.all).toContain("GDPR Art. 33(1)");
    expect(dm.all).toContain("72h authority deadline");
    expect(actionsOf(dm, "processing_role")).toEqual(["fact_confirm", "fact_wrong", "fact_dont_know"]);
    const ids = allActionIds(dm);
    expect(ids).toEqual(expect.arrayContaining(["severity", "awareness", "sign_decision:gdpr.notify_authority", "sign_decision:gdpr.inform_subjects", "sign_decision:gdpr.notify_controller"]));
    const sev = dm.blocks.flatMap((b) => (b.elements as { action_id?: string }[]) ?? []).find((e) => e.action_id === "severity") as { options: { value: string }[] };
    expect(sev.options.map((o) => JSON.parse(o.value))).toContainEqual({ incidentId: INCIDENT_ID, severity: "major" });
  });

  it("a role with nothing left to answer is told so, and how to add or change something", () => {
    const s = snap({ ...NUVOLA, records_count: 2400, subjects_categories: ["customers"], people_affected: false, can_contact_individually: true, cross_border: false });
    for (const k of Object.keys(s.facts)) s.facts[k] = { ...s.facts[k], state: "confirmed", method: "human" };
    expect(dmFor("business_owner", s)?.questionIds).toEqual([]);
    expect(dmFor("business_owner", s)?.all).toContain("Nothing more needed from you for now.");
  });

  it("cuts the DM title at the first clause (semicolon included)", () => {
    const dm = buildDm("lawyer", { snapshot: snap(NUVOLA), assessment: evaluate(snap(NUVOLA)), brief: "Employee suspects phishing link click; laptop behaves abnormally.", now });
    expect(dm?.blocks[0]).toMatchObject({ type: "header", text: { text: "Incident · Employee suspects phishing link click" } });
  });

  it("links the live report on the site, except for the reporter (Q12: no outcome)", () => {
    expect(dmFor("dpo")?.all).toContain(`https://hackathon-mistral.vercel.app/incidents/${INCIDENT_ID}|Live report`);
    expect(dmFor("reporter")?.all ?? "").not.toContain("/incidents/");
  });

  it("as processor, only the client notification is ours to sign: no CNIL / people buttons, nothing else 'needed'", () => {
    const s = snap({ ...NUVOLA, processing_role: "processor", contract_mandate: true });
    for (const k of Object.keys(s.facts)) s.facts[k] = { ...s.facts[k], state: "confirmed", method: "human", confirmedBy: "Cécile" };
    expect(evaluate(s).obligations.find((o) => o.id === "gdpr.notify_authority")?.status).toBe("controller_duty");
    const signs = (role: Role) => allActionIds(dmFor(role, s)).filter((i) => i.startsWith("sign_decision"));
    expect(signs("dpo")).toEqual(["sign_decision:gdpr.notify_controller"]);
    expect(signs("lawyer")).toEqual(["sign_decision:gdpr.notify_controller"]);
    expect(dmFor("lawyer", s)?.all).toContain("• *Tell the client?* needed");
    expect(dmFor("lawyer", s)?.all).not.toMatch(/Report to the CNIL\?|Tell the people affected\?/);
  });

  it("severity and awareness are the DPO's; signing buttons only go to SIGNERS, each with its own stage", () => {
    for (const role of Role.options) {
      const dm = dmFor(role, snap(NUVOLA));
      const ids = allActionIds(dm);
      if (role !== "dpo") expect(ids.filter((i) => i === "severity" || i === "awareness"), role).toEqual([]);
      const signs = (dm?.blocks ?? [])
        .flatMap((b) => (b.elements as { action_id: string; value: string }[] | undefined) ?? [])
        .filter((e) => e.action_id?.startsWith("sign_decision"));
      const stage = (Object.keys(SIGNERS) as (keyof typeof SIGNERS)[]).find((k) => SIGNERS[k] === role);
      expect(signs.map((e) => JSON.parse(e.value).stage), role).toEqual(stage ? [stage, stage, stage] : []);
      if (role !== "lawyer") expect(ids.filter((i) => i.startsWith("lawyer_")), role).toEqual([]);
    }
  });

  it("management is not in the average wave; communications never gets a DM", () => {
    expect(waveFor("average")).not.toContain("management");
    expect(dmFor("communications")).toBeNull();
  });

  const rec = (choice: "notify" | "defer", stage: "recommendation" | "decision" = "recommendation"): DecisionStatus => ({
    obligationId: "gdpr.notify_authority",
    stage,
    eventId: 9,
    at: "2026-10-04T09:30:00Z",
    status: "current",
    decision: {
      type: "decision",
      stage,
      by: stage === "recommendation" ? { role: "dpo", name: "Claire Martin" } : { role: "lawyer", name: "Inès Haddad" },
      obligationId: "gdpr.notify_authority",
      choice,
      reasons: "Facts relied on: personal_data.\nRisk factors: 2,400 contacts exported.",
      factsVersion: 5,
      moduleVersion: "x",
    },
  });

  it("Q14: the lawyer's DM has each fact's state, open questions, the DPO's recommendation, deadlines and three actions", () => {
    const s = snap(NUVOLA);
    s.facts.encrypted = { ...s.facts.encrypted, state: "confirmed", confirmedBy: "Hugo Leroy" };
    s.facts.keys_safe = { value: null, state: "proposed", method: "llm", sources: [] };
    const dm = dmFor("lawyer", s, { decisions: [rec("notify")] })!;
    expect(dm.text).toContain("Files were encrypted: No — confirmed by Hugo Leroy");
    expect(dm.text).toContain("Our data or a client's: controller — proposed by the AI, not confirmed");
    expect(dm.text).toContain("Password or key still safe: unknown — unknown");
    expect(dm.text).toContain("*Open questions*\n• ");
    expect(dm.text).toContain("subjects_categories (asked to business owner)");
    expect(dm.text).toContain("*DPO recommendations*\n• Notify the data protection authority (CNIL): *notify*, by Claire Martin");
    expect(dm.text).toContain("2,400 contacts exported");
    expect(dm.text).toContain("72h authority deadline");
    expect(dm.text).toContain("without undue delay");
    expect(dm.text).toContain("Your decision is needed");
    expect(actionsOf(dm, "sign")).toEqual([
      "sign_decision:gdpr.notify_authority",
      "sign_decision:gdpr.inform_subjects",
      "sign_decision:gdpr.notify_controller",
      "dm_details",
      "lawyer_ask",
      "lawyer_request_facts",
    ]);
    expect(dm.questionIds).toEqual([]); // the lawyer holds no fact: never asked the other roles' questions
  });

  it("Q7: within 12 h of the deadline, still undetermined or deferred, the DPO and the lawyer see the phased notification line", () => {
    const deferred = { decisions: [rec("defer")] };
    const early = new Date("2026-10-06T20:00:00+02:00"); // deadline 2026-10-07 09:12 Paris: 13 h before
    const late = new Date("2026-10-06T22:00:00+02:00"); // 11 h before
    for (const role of ["dpo", "lawyer"] as const) {
      expect(dmFor(role, snap(NUVOLA), { ...deferred, now: early })!.text, role).not.toContain("phased notification");
      expect(dmFor(role, snap(NUVOLA), { ...deferred, now: late })!.text, role).toContain("phased notification (Art. 33(4))");
      // a signed decision to notify settles it; "required" without deferral does not trigger it
      expect(dmFor(role, snap(NUVOLA), { decisions: [rec("defer"), rec("notify", "decision")], now: late })!.text).not.toContain("phased notification");
      // facts still to confirm near the deadline also call for a phased notification (rules 1.0.0: unknown = yes)
      expect(dmFor(role, snap(NUVOLA), { now: late })!.text).toContain("phased notification");
    }
    expect(dmFor("dpo", snap({ ...NUVOLA, personal_data: null }), { now: late })!.text).toContain("phased notification");
    expect(dmFor("it", snap(NUVOLA), { ...deferred, now: late })!.text).not.toContain("phased");
  });

  it("Q12: the reporter only gets the acknowledgement, never the outcome", () => {
    const dm = dmFor("reporter", snap(NUVOLA), { decisions: [rec("notify"), rec("notify", "decision")] })!;
    expect(dm.text).toContain("your report was received");
    expect(dm.all).not.toMatch(/notify|CNIL|required|decision|Art\./i);
    expect(allActionIds(dm)).toEqual([]);
  });

  it("property: no DM ever contains another role's questions, nor (outside DPO/lawyer) another role's facts", () => {
    const snapshots = [snap(NUVOLA), snap({ personal_data: true }), snap({}), snap({ ...NUVOLA, processing_role: "processor" })];
    let checked = 0;
    for (const s of snapshots)
      for (const role of Role.options) {
        const dm = dmFor(role, s);
        if (!dm) continue;
        for (const q of GDPR_QUESTIONS.filter((q) => q.role !== role)) expect(dm.all, `${role} sees ${q.id}`).not.toContain(q.text);
        const rule = ROLE_MATRIX[role]!;
        if (!rule.facts && rule.assessment !== "full")
          for (const [k, d] of Object.entries(GDPR_FACTS)) if (d.role !== role) expect(dm.all, `${role} sees ${k}`).not.toMatch(new RegExp(`\\b${k}\\b`));
        checked++;
      }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("sober layout (#57)", () => {
  const ROLES = ["it", "business_owner", "dpo", "lawyer", "management"] as const;
  const late = new Date("2026-10-06T22:00:00+02:00");
  const cases = [snap(NUVOLA), snap({}), snap({ ...NUVOLA, processing_role: "processor" })];

  it("every role's DM starts with a header, has at most one divider, no emoji, and stays within Slack's limits", () => {
    for (const s of cases)
      for (const role of [...ROLES, "reporter"] as const)
        for (const at of [now, late]) {
          const dm = dmFor(role, s, { now: at })!;
          expect(dm.blocks[0].type, role).toBe("header");
          expect(dm.blocks.filter((b) => b.type === "divider").length, role).toBeLessThanOrEqual(1);
          expect(JSON.stringify(dm.blocks), role).not.toMatch(/\p{Extended_Pictographic}/u);
          expect(dm.blocks.length, role).toBeLessThanOrEqual(50);
          for (const b of dm.blocks) expect(((b.fields as unknown[]) ?? []).length).toBeLessThanOrEqual(10);
        }
  });

  it("same order for every role: header, context, then at most 6 information blocks before the first control", () => {
    for (const role of ROLES) {
      const dm = dmFor(role, snap(NUVOLA), { decisions: [] })!;
      expect(dm.blocks[1].type, role).toBe("context");
      const firstControl = dm.blocks.findIndex((b) => b.type === "divider" || b.type === "actions");
      expect(firstControl === -1 ? dm.blocks.length : firstControl, role).toBeLessThanOrEqual(8);
    }
  });

  it("context shows the CNIL deadline only to roles with the clock; the DPO and the lawyer get a View details button", () => {
    const ctx = (role: Role) => JSON.stringify(dmFor(role)!.blocks[1]);
    expect(ctx("dpo")).toContain("CNIL deadline: *07/10/2026 09:12* Paris (provisional)");
    expect(ctx("management")).toContain("CNIL deadline");
    for (const role of ["it", "business_owner"] as const) expect(ctx(role), role).not.toMatch(/CNIL|Severity/);
    for (const role of ROLES) expect(allActionIds(dmFor(role)).includes("dm_details"), role).toBe(role === "dpo" || role === "lawyer");
    const dm = dmFor("lawyer")!;
    expect(dm.details.join("\n")).toContain("GDPR Art. 33(1)");
    expect(JSON.stringify(dm.blocks)).not.toContain("GDPR Art. 33(1)"); // reasons and legal refs only behind View details
    expect(JSON.stringify(dmFor("dpo")!.blocks)).toContain("*Personal data involved*\\nYes · to confirm");
    // Martyna reads on a phone: one line per open decision, no facts grid.
    expect(JSON.stringify(dm.blocks)).toContain("• *Report to the CNIL?* needed · no DPO advice yet");
    expect(JSON.stringify(dm.blocks)).not.toContain("Personal data involved*\\n");
  });
});

describe("waves", () => {
  it("routes by severity, unknown severity uses the average wave", () => {
    expect(WAVES.false_positive.sort()).toEqual(["it", "reporter"]);
    expect(WAVES.minimal.sort()).toEqual(["dpo", "it"]);
    expect(WAVES.average.sort()).toEqual(["business_owner", "dpo", "it", "lawyer"]);
    expect(WAVES.major.sort()).toEqual(["business_owner", "dpo", "it", "lawyer", "management"]);
    expect(waveFor(null)).toEqual(WAVES.average);
  });
});

describe("notifyWave", () => {
  beforeEach(() => {
    m.loadSnapshot.mockResolvedValue(snap(NUVOLA));
    m.recordEvent.mockImplementation(async ({ expectedVersion }) => expectedVersion + 1);
  });
  afterEach(() => vi.restoreAllMocks());

  it("records one notification per DM, failed sends included", async () => {
    m.db.mockImplementation(
      fakeDb({
        people: [
          { id: "p-it", name: "Hugo Leroy", role: "it", slack_user_id: "U_IT" },
          { id: "p-dpo", name: "Claire Martin", role: "dpo", slack_user_id: null },
        ],
        incident_events: [],
      }),
    );
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("conversations.open") ? slackOk({ channel: { id: "D1" } }) : slackOk({ channel: "D1", ts: "1.1" }),
    );

    const res = await notifyWave(INCIDENT_ID, now);

    expect(fetch).toHaveBeenCalledTimes(2); // open + post for IT only
    expect(res.map((r) => r.delivered)).toEqual([true, false]);
    const calls = m.recordEvent.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.expectedVersion)).toEqual([5, 6]);
    expect(calls[0].idempotencyKey).toBe(`notify:${INCIDENT_ID}:p-it:questions:5`);
    expect(calls[0].event).toMatchObject({ type: "notification", delivered: true, slack: { channel: "D1", ts: "1.1" }, to: { role: "it" } });
    expect(calls[1].event).toMatchObject({ delivered: false, slack: null, error: expect.stringContaining("slack_user_id") });
  });
});
