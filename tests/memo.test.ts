// Lawyer's reasoning memo (#56): guardrails on the model output, trigger after a DPO recommendation, "Regenerate" (lawyer only).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";
import { evaluate } from "@/lib/regulations/gdpr";
import { MEMO_TITLE, validateMemo, type Memo } from "@/lib/services/memo";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn(), listEvents: vi.fn(), callMistral: vi.fn(), tasks: [] as Promise<unknown>[] }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({
  ...(await orig<object>()),
  db: m.db,
  loadSnapshot: m.loadSnapshot,
  recordEvent: m.recordEvent,
  listEvents: m.listEvents,
}));
vi.mock("@/lib/adapters/mistral", () => ({ callMistral: m.callMistral, GUARD: "guard", draftNarrative: async () => null }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(Promise.resolve().then(fn)) }));

import { POST } from "@/app/api/slack/interactions/route";

const LEGAL = readFileSync("docs/legal/decisions-2026-10-04.md", "utf8");
const SNAP = snap(NUVOLA); // notify_authority required, inform_subjects undetermined, notify_controller undetermined
const memo = (o: Partial<Memo["obligations"][number]> & { obligationId: string }, summary: string[] = []): Memo => ({
  summary,
  obligations: [{ strengths: [], weaknesses: [], missingFacts: [], citations: [], ...o }],
});

describe("validateMemo: the memo never contradicts evaluate()", () => {
  const a = evaluate(SNAP);
  it("precondition: the computed statuses", () => {
    expect(Object.fromEntries(a.obligations.map((o) => [o.id, o.status]))).toMatchObject({ "gdpr.notify_authority": "required", "gdpr.inform_subjects": "undetermined" });
  });

  it("drops a sentence asserting a status different from the computed one, keeps the consistent ones", () => {
    const out = validateMemo(
      {
        summary: ["Notifying the CNIL is not required.", "Notifying the CNIL is required, facts to confirm.", "Informing individuals is required.", "Nothing is mandatory here."],
        obligations: [
          { obligationId: "gdpr.notify_authority", strengths: ["Contact data of 2,400 customers was exported.", "Notification is not required since data was encrypted."], weaknesses: ["This stays undetermined."], missingFacts: [], citations: [] },
          { obligationId: "gdpr.inform_subjects", strengths: ["Informing people is mandatory."], weaknesses: ["No presumption applies: the outcome stays undetermined."], missingFacts: [], citations: [] },
        ],
      },
      a,
      SNAP,
      LEGAL,
    )!;
    expect(out.summary).toEqual(["Notifying the CNIL is required, facts to confirm."]);
    expect(out.obligations).toEqual([
      { obligationId: "gdpr.notify_authority", strengths: ["Contact data of 2,400 customers was exported."], weaknesses: [], missingFacts: [], citations: [] },
      { obligationId: "gdpr.inform_subjects", strengths: [], weaknesses: ["No presumption applies: the outcome stays undetermined."], missingFacts: [], citations: [] },
    ]);
  });

  it("keeps only real fact keys (not already confirmed) in missingFacts", () => {
    const s = { ...SNAP, facts: { ...SNAP.facts, encrypted: { ...SNAP.facts.encrypted, state: "confirmed" as const } } };
    const out = validateMemo(memo({ obligationId: "gdpr.notify_authority", missingFacts: ["keys_safe", "attacker_ip", "encrypted", "keys_safe"] }), evaluate(s), s, LEGAL)!;
    expect(out.obligations[0].missingFacts).toEqual(["keys_safe"]);
  });

  it("drops citations that do not appear in docs/legal", () => {
    const citations = ["EDPB para 119", "EDPB para 999", "Art. 99", "Recital 85", "GDPR Art. 34(3)(b)", "para 21", "para 1"];
    const out = validateMemo(memo({ obligationId: "gdpr.notify_authority", strengths: ["Data was exported."], citations }), a, SNAP, LEGAL)!;
    expect(out.obligations[0].citations).toEqual(["EDPB para 119", "GDPR Art. 34(3)(b)", "para 21"]);
  });

  it("an unknown obligation or a memo emptied by the guardrails is nothing", () => {
    expect(validateMemo(memo({ obligationId: "gdpr.pay_ransom", strengths: ["Pay."] }), a, SNAP, LEGAL)).toBeNull();
    expect(validateMemo(memo({ obligationId: "gdpr.notify_authority", strengths: ["Not required."] }, ["Informing individuals is required."]), a, SNAP, LEGAL)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Through the signed Slack route
// ---------------------------------------------------------------------------

const PEOPLE = [
  { name: "Claire Martin", role: "dpo", slack_user_id: "U_DPO" },
  { name: "Hugo Leroy", role: "it", slack_user_id: "U_IT" },
  { name: "Inès Haddad", role: "lawyer", slack_user_id: "U_LAW" },
];
const SECRET = "test-signing-secret";
const form = (payload: object) => "payload=" + encodeURIComponent(JSON.stringify(payload));
const sign = (body: string) => {
  const ts = Math.floor(Date.now() / 1000);
  return new Headers({ "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") });
};
const action = (user: string, a: object) =>
  form({
    type: "block_actions",
    user: { id: user },
    trigger_id: "trig.1",
    actions: [{ action_ts: "1790000000.123", ...a }],
    container: { channel_id: "D1", message_ts: "1.1" },
    response_url: "https://hooks.slack.com/actions/x",
  });
const regenerate = (user: string) => action(user, { action_id: "memo_regenerate", value: JSON.stringify({ incidentId: INCIDENT_ID }) });
const text = (value: string | null) => ({ type: "plain_text_input", value });
const sign_decision = (user: string, stage: "recommendation" | "decision") =>
  form({
    type: "view_submission",
    user: { id: user },
    view: {
      id: "V123",
      callback_id: "sign_decision",
      private_metadata: JSON.stringify({ incidentId: INCIDENT_ID, obligationId: "gdpr.notify_authority", stage, channel: "D1", ts: "1.1" }),
      state: {
        values: {
          choice: { choice: { type: "radio_buttons", selected_option: { value: "notify" } } },
          factsReliedOn: { factsReliedOn: { type: "multi_static_select", selected_options: [{ value: "personal_data" }] } },
          riskFactors: { riskFactors: text("Contact data of 2,400 customers exported.") },
          exceptionRelied: { exceptionRelied: text(null) },
          evidence: { evidence: text(null) },
          freeText: { freeText: text(null) },
          override: { override: { type: "checkboxes", selected_options: [] } },
        },
      },
    },
  });

async function post(body: string) {
  const res = await POST(new Request("http://localhost/api/slack/interactions", { method: "POST", body, headers: sign(body) }));
  await Promise.all(m.tasks.splice(0));
  return res;
}

const GOOD: Memo = {
  summary: ["Contact data of 2,400 customers was exported by phishing.", "Notifying the CNIL is required, facts to confirm."],
  obligations: [{ obligationId: "gdpr.notify_authority", strengths: ["Data was exported."], weaknesses: ["Encryption is not confirmed."], missingFacts: ["keys_safe"], citations: ["EDPB para 119"] }],
};

describe("memo in Slack", () => {
  let fetch: MockInstance<typeof globalThis.fetch>;
  const bodies = (method: string) => fetch.mock.calls.filter((c) => String(c[0]).endsWith(method)).map((c) => JSON.parse(c[1]!.body as string));
  const memoPosts = () => [...bodies("chat.postMessage"), ...bodies("chat.update")].filter((b) => b.text.startsWith(MEMO_TITLE));
  const memoEvents = () => m.recordEvent.mock.calls.map((c) => c[0]).filter((a) => a.event.type === "notification" && a.event.preview.startsWith(MEMO_TITLE));
  let error: MockInstance;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:00+02:00"));
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    m.recordEvent.mockReset().mockResolvedValue(6);
    m.callMistral.mockReset().mockResolvedValue({ output: GOOD, model: "magistral-medium-latest" });
    m.loadSnapshot.mockImplementation(async () => snap(NUVOLA));
    m.listEvents.mockResolvedValue([]);
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => (String(url).endsWith("conversations.open") ? slackOk({ channel: { id: "D9" } }) : slackOk({ channel: "D9", ts: "9.9" })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a DPO recommendation posts the memo to the lawyer as its own message and records it with the versions", async () => {
    expect((await post(sign_decision("U_DPO", "recommendation"))).status).toBe(200);
    expect(m.callMistral).toHaveBeenCalledTimes(1);
    expect(m.callMistral.mock.calls[0][0]).toBe("memo");
    const [msg] = memoPosts();
    expect(memoPosts()).toHaveLength(1);
    expect(msg.channel).toBe("D9");
    expect(msg.blocks[0]).toMatchObject({ type: "header", text: { text: "⚠️ Data breach — what we need to do" } });
    const all = JSON.stringify(msg.blocks);
    expect(all).toContain("memo_regenerate");
    expect(all).toContain("*At a glance*");
    expect(all).toContain("🔴 *Report to the CNIL* — required, within 72h");
    expect(all).toContain("*What happened*");
    // What the reader sees (every "text" string, minus Slack's date token): no "para 119", "Q5" or fact keys.
    const seen = [...all.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/<!date[^>]*>/g, "")).join(" ");
    expect(seen).not.toMatch(/para \d|\bQ\d+\b|\b[a-z]+_[a-z_]+\b/);
    expect(memoEvents()).toHaveLength(1);
    expect(memoEvents()[0].event).toMatchObject({ type: "notification", kind: "assessment", to: { role: "lawyer", slackUserId: "U_LAW" }, delivered: true, slack: { channel: "D9", ts: "9.9" } });
    expect(memoEvents()[0].event.preview).toContain("Facts v5, rules gdpr 1.0.0");
  });

  it("no memo after other events: the lawyer's decision, an answer", async () => {
    await post(sign_decision("U_LAW", "decision"));
    await post(action("U_IT", { action_id: "answer_no", value: JSON.stringify({ incidentId: INCIDENT_ID, factKey: "encrypted", answer: "no" }) }));
    expect(m.callMistral).not.toHaveBeenCalled();
    expect(memoPosts()).toHaveLength(0);
  });

  it("a failed model call posts and records nothing (logged)", async () => {
    m.callMistral.mockRejectedValue(new Error("429"));
    expect((await post(sign_decision("U_DPO", "recommendation"))).status).toBe(200);
    expect(memoPosts()).toHaveLength(0);
    expect(memoEvents()).toHaveLength(0);
    expect(error).toHaveBeenCalledWith("memo: model call failed", expect.any(Error));
  });

  it("a memo emptied by the guardrails posts nothing", async () => {
    m.callMistral.mockResolvedValue({ output: memo({ obligationId: "gdpr.notify_authority", strengths: ["It is not required."] }), model: "x" });
    await post(sign_decision("U_DPO", "recommendation"));
    expect(memoPosts()).toHaveLength(0);
    expect(memoEvents()).toHaveLength(0);
  });

  it("Regenerate: only the lawyer; anyone else gets an ephemeral refusal and nothing is generated", async () => {
    await post(regenerate("U_DPO"));
    expect(m.callMistral).not.toHaveBeenCalled();
    expect(bodies("actions/x")[0]).toMatchObject({ response_type: "ephemeral", text: expect.stringContaining("Only the lawyer") });

    await post(regenerate("U_LAW"));
    expect(m.callMistral).toHaveBeenCalledTimes(1);
    expect(bodies("chat.update")).toEqual([expect.objectContaining({ channel: "D1", ts: "1.1", text: expect.stringContaining(MEMO_TITLE) })]);
    expect(memoEvents()[0]).toMatchObject({ actor: "slack:U_LAW", event: { slack: { channel: "D1", ts: "1.1" } } });
  });

  it("refreshing the DMs never overwrites the memo message with the case DM", async () => {
    const to = { role: "lawyer", name: "Inès Haddad", slackUserId: "U_LAW" };
    const notif = (preview: string, ts: string) => ({ type: "notification", to, kind: "assessment", questionIds: [], preview, slack: { channel: "D7", ts }, delivered: true });
    m.listEvents.mockResolvedValue([
      { id: 1, at: "2026-10-04T10:00:00+02:00", actor: "notify", event: notif("Case", "7.1") },
      { id: 2, at: "2026-10-04T10:01:00+02:00", actor: "memo", event: notif(`${MEMO_TITLE}, Facts v5: ...`, "7.2") },
    ]);
    await post(action("U_IT", { action_id: "answer_no", value: JSON.stringify({ incidentId: INCIDENT_ID, factKey: "encrypted", answer: "no" }) }));
    const updated = bodies("chat.update").map((b) => b.ts);
    expect(updated).toContain("7.1");
    expect(updated).not.toContain("7.2");
  });
});
