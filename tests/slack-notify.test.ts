import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS, GDPR_QUESTIONS } from "@/lib/regulations/gdpr/facts";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn() }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({ ...(await orig<object>()), ...m }));

import { ROLE_MATRIX, WAVES, buildDm, notifyWave, waveFor } from "@/lib/services/notify";

const now = new Date("2026-10-04T10:00:00+02:00");
type Dm = { blocks: Record<string, unknown>[] } | null;
const allActionIds = (dm: Dm) =>
  (dm?.blocks ?? []).flatMap((b) => [...((b.elements as { action_id: string }[]) ?? []), ...(b.accessory ? [b.accessory as { action_id: string }] : [])]).map((e) => e.action_id);
const actionsOf = (dm: Dm, blockId: string) => allActionIds({ blocks: (dm?.blocks ?? []).filter((b) => b.block_id === blockId) });
const dmFor = (role: Role, s = snap(NUVOLA)) => {
  const dm = buildDm(role, { snapshot: s, assessment: evaluate(s), brief: "Phishing on the CRM: 3 exports downloaded.", now });
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
    expect(actionsOf(dm, "encrypted")).toEqual(["fact_confirm", "fact_wrong"]);
    expect(actionsOf(dm, "breach_type")).toEqual(["fact_confirm", "fact_wrong"]);
    expect(actionsOf(dm, "still_exposed")).toEqual(["answer_yes", "answer_no", "answer_unknown"]);
    expect(dm.all).toContain("The AI suggests: *No*");
    expect(dm.all).toContain("about encrypted");
  });

  it("a fact answered \"I don't know\" by a human is not asked again", () => {
    const s = snap(NUVOLA);
    s.facts.still_exposed = { value: null, state: "confirmed", method: "human", sources: [], confirmedBy: "Hugo", confirmedAt: "2026-10-04T10:00:00Z" };
    const dm = dmFor("it", s)!;
    expect(dm.questionIds).not.toContain("gdpr.still_exposed");
    expect(actionsOf(dm, "still_exposed")).toEqual([]);
  });

  it("non-boolean unknown or disputed facts get an Answer button", () => {
    expect(actionsOf(dmFor("business_owner")!, "subjects_categories")).toEqual(["fact_input"]); // unknown, blocking
    const s = snap(NUVOLA);
    s.facts.processing_role.state = "disputed";
    const dm = dmFor("dpo", s)!;
    expect(actionsOf(dm, "processing_role")).toEqual(["fact_input"]);
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
    expect(actionsOf(dm, "processing_role")).toEqual(["fact_confirm", "fact_wrong"]);
    const ids = allActionIds(dm);
    expect(ids).toEqual(expect.arrayContaining(["severity", "awareness", "sign_decision:gdpr.notify_authority", "sign_decision:gdpr.inform_subjects", "sign_decision:gdpr.notify_controller"]));
    const sev = dm.blocks.find((b) => (b.accessory as { action_id?: string })?.action_id === "severity")!.accessory as { options: { value: string }[] };
    expect(sev.options.map((o) => JSON.parse(o.value))).toContainEqual({ incidentId: INCIDENT_ID, severity: "major" });
  });

  it("no other role ever gets the severity, awareness or signature controls", () => {
    for (const role of Role.options.filter((r) => r !== "dpo")) {
      const ids = allActionIds(dmFor(role, snap(NUVOLA)));
      expect(ids.filter((i) => i === "severity" || i === "awareness" || i.startsWith("sign_decision")), role).toEqual([]);
    }
  });

  it("management is not in the average wave; communications never gets a DM", () => {
    expect(waveFor("average")).not.toContain("management");
    expect(dmFor("communications")).toBeNull();
  });

  it("the lawyer is asked to decide only while informing the people concerned is undetermined", () => {
    expect(dmFor("lawyer")!.all).toContain("Your decision is needed");
    const decided = snap({ ...NUVOLA, data_categories: ["financial"] });
    expect(dmFor("lawyer", decided)!.all).not.toContain("Your decision is needed");
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
