import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS, GDPR_QUESTIONS } from "@/lib/regulations/gdpr/facts";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn() }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({ ...(await orig<object>()), ...m }));

import { ROLE_MATRIX, WAVES, buildDm, notifyWave, waveFor } from "@/lib/services/notify";

const now = new Date("2026-10-04T10:00:00+02:00");
const dmFor = (role: Role, s = snap(NUVOLA)) => {
  const dm = buildDm(role, { snapshot: s, assessment: evaluate(s), brief: "Phishing on the CRM: 3 exports downloaded.", now });
  return dm && { ...dm, all: dm.text + JSON.stringify(dm.blocks) };
};

describe("role scoping (Nuvola, severity average)", () => {
  it("IT gets its own questions with buttons and no legal reasoning", () => {
    const dm = dmFor("it")!;
    expect(dm.questionIds.sort()).toEqual(["gdpr.encrypted", "gdpr.keys_safe", "gdpr.still_exposed"]);
    expect(dm.blocks.filter((b) => b.type === "actions").map((b) => b.block_id)).toEqual(expect.arrayContaining(["encrypted", "keys_safe"]));
    const a = evaluate(snap(NUVOLA));
    for (const o of a.obligations) for (const s of [...o.reasons, ...o.legalRefs, o.id]) expect(dm.all).not.toContain(s);
    expect(dm.all).not.toMatch(/GDPR|Art\.|required|CNIL|deadline/i);
  });

  it("management is not in the average wave; communications never gets a DM", () => {
    expect(waveFor("average")).not.toContain("management");
    expect(dmFor("communications")).toBeNull();
  });

  it("the DPO gets the assessment, the clock and its own question as text (non-boolean)", () => {
    const dm = dmFor("dpo")!;
    expect(dm.questionIds).toEqual(["gdpr.processing_role"]);
    expect(dm.all).toContain("GDPR Art. 33(1)");
    expect(dm.all).toContain("72h authority deadline");
    expect(dm.blocks.some((b) => b.type === "actions")).toBe(false);
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
