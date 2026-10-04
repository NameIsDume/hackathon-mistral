import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { verifySlackSignature } from "@/lib/adapters/slack";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn(), listEvents: vi.fn(), tasks: [] as Promise<unknown>[] }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({
  ...(await orig<object>()),
  db: m.db,
  loadSnapshot: m.loadSnapshot,
  recordEvent: m.recordEvent,
  listEvents: m.listEvents,
}));
vi.mock("@/lib/adapters/mistral", () => ({ draftNarrative: async () => "A phishing email led to the export of customer contact data." }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(Promise.resolve().then(fn)) }));

import { POST } from "@/app/api/slack/interactions/route";

const PEOPLE = [
  { name: "Claire Martin", role: "dpo", slack_user_id: "U_DPO" },
  { name: "Hugo Leroy", role: "it", slack_user_id: "U_IT" },
  { name: "Inès Haddad", role: "lawyer", slack_user_id: "U_LAW" },
];
const SECRET = "test-signing-secret";
const NOW = 1_790_000_000;
const sign = (body: string, ts = NOW, secret = SECRET) =>
  new Headers({
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex"),
  });

describe("verifySlackSignature", () => {
  const body = "payload=%7B%7D";
  it("accepts a valid signature", () => expect(verifySlackSignature(body, sign(body), SECRET, NOW)).toBe(true));
  it("rejects a tampered body, a wrong secret, a 6-minute-old timestamp", () => {
    expect(verifySlackSignature(body + "x", sign(body), SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(body, sign(body, NOW, "other"), SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(body, sign(body, NOW - 360), SECRET, NOW)).toBe(false);
  });
});

const form = (payload: object) => "payload=" + encodeURIComponent(JSON.stringify(payload));
const action = (user: string, a: object) =>
  form({
    type: "block_actions",
    user: { id: user },
    trigger_id: "trig.1",
    actions: [{ action_ts: "1790000000.123", ...a }],
    container: { channel_id: "D1", message_ts: "1.1" },
    response_url: "https://hooks.slack.com/actions/x",
  });
const click = (factKey = "encrypted", answer = "no") =>
  action("U_IT", { action_id: `answer_${answer}`, value: JSON.stringify({ incidentId: INCIDENT_ID, factKey, answer }) });
const factButton = (actionId: string, factKey: string, user = "U_IT") =>
  action(user, { action_id: actionId, value: JSON.stringify({ incidentId: INCIDENT_ID, factKey }) });
const submit = (user: string, callbackId: string, meta: object, values: object) =>
  form({
    type: "view_submission",
    user: { id: user },
    view: { id: "V123", callback_id: callbackId, private_metadata: JSON.stringify({ ...meta, channel: "D1", ts: "1.1" }), state: { values } },
  });
const decision = (user: string, reasons: string) =>
  submit(
    user,
    "sign_decision",
    { incidentId: INCIDENT_ID, obligationId: "gdpr.notify_authority" },
    {
      choice: { choice: { type: "radio_buttons", selected_option: { value: "notify" } } },
      reasons: { reasons: { type: "plain_text_input", value: reasons } },
    },
  );

async function post(body: string, headers = sign(body, Math.floor(Date.now() / 1000))) {
  const res = await POST(new Request("http://localhost/api/slack/interactions", { method: "POST", body, headers }));
  await Promise.all(m.tasks.splice(0));
  return res;
}

describe("POST /api/slack/interactions", () => {
  let fetch: MockInstance<typeof globalThis.fetch>;
  const bodies = (method: string) => fetch.mock.calls.filter((c) => String(c[0]).endsWith(method)).map((c) => JSON.parse(c[1]!.body as string));
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    m.recordEvent.mockReset().mockResolvedValue(6);
    m.loadSnapshot.mockImplementation(async () => snap(NUVOLA));
    m.listEvents.mockResolvedValue([]);
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => (String(url).endsWith("conversations.open") ? slackOk({ channel: { id: "D9" } }) : slackOk({ channel: "D9", ts: "9.9" })));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects an invalid signature with 401 and does nothing", async () => {
    const body = click();
    const res = await post(body, sign(body, Math.floor(Date.now() / 1000), "wrong"));
    expect(res.status).toBe(401);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("refuses a user who does not hold the fact's role: no write", async () => {
    m.db.mockImplementation(fakeDb({ people: [{ name: "Claire Martin", role: "dpo", slack_user_id: "U_IT" }] }));
    expect((await post(click())).status).toBe(200);
    expect(m.recordEvent).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ response_type: "ephemeral" });
  });

  it("records a confirmed fact and an answer event, then updates the DM", async () => {
    expect((await post(click("encrypted", "no"))).status).toBe(200);
    expect(m.recordEvent).toHaveBeenCalledTimes(1);
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.expectedVersion).toBe(5);
    expect(arg.facts.encrypted).toMatchObject({ value: false, state: "confirmed", method: "human", confirmedBy: "Hugo Leroy" });
    expect(arg.facts.severity).toMatchObject({ value: "average" }); // record_event replaces the whole facts object
    expect(arg.facts.processing_role.value).toBe("controller");
    expect(arg.event).toEqual({ type: "answer", by: { role: "it", name: "Hugo Leroy", slackUserId: "U_IT" }, factKey: "encrypted", answer: "no", via: "slack" });
    expect(bodies("chat.update")[0]).toMatchObject({ channel: "D1", ts: "1.1", text: "Answer recorded: No" });
  });

  it("retries once on a version conflict, from a fresh snapshot", async () => {
    const { VersionConflict } = await import("@/lib/adapters/supabase");
    m.loadSnapshot.mockImplementationOnce(async () => snap(NUVOLA, "average", 5)).mockImplementationOnce(async () => snap(NUVOLA, "average", 7));
    m.recordEvent.mockRejectedValueOnce(new VersionConflict("x")).mockResolvedValueOnce(8);
    await post(click());
    expect(m.recordEvent.mock.calls.map((c) => c[0].expectedVersion)).toEqual([5, 7]);
  });

  it("a replayed action carries the same idempotency key", async () => {
    await post(click());
    await post(click());
    const keys = m.recordEvent.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual(["slack:1790000000.123:U_IT", "slack:1790000000.123:U_IT"]);
  });

  it("Confirm on an AI-proposed fact confirms its value and records an answer event", async () => {
    await post(factButton("fact_confirm", "encrypted"));
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.facts.encrypted).toMatchObject({ value: false, state: "confirmed", method: "human", confirmedBy: "Hugo Leroy", sources: [{ excerpt: "about encrypted" }] });
    expect(arg.event).toMatchObject({ type: "answer", factKey: "encrypted", answer: "no", via: "slack" });
    expect(arg.idempotencyKey).toBe("slack:1790000000.123:U_IT");
    expect(bodies("chat.update")[0]).toMatchObject({ channel: "D1", ts: "1.1", text: "Confirmed: No" });
  });

  it("\"I don't know\" is recorded as answered by a human, value still unknown", async () => {
    await post(click("keys_safe", "unknown"));
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.facts.keys_safe).toMatchObject({ value: null, state: "confirmed", method: "human", confirmedBy: "Hugo Leroy" });
    expect(arg.event).toMatchObject({ type: "answer", factKey: "keys_safe", answer: "unknown" });
  });

  it("Wrong marks the fact disputed (value kept for the record) and the refreshed DM asks for the right value", async () => {
    await post(factButton("fact_wrong", "breach_type"));
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.facts.breach_type).toMatchObject({ value: ["confidentiality"], state: "disputed", method: "human" });
    expect(arg.event).toMatchObject({ type: "answer", factKey: "breach_type", answer: "unknown" });
  });

  it("someone without the fact's role cannot confirm it", async () => {
    await post(factButton("fact_confirm", "encrypted", "U_DPO"));
    expect(m.recordEvent).not.toHaveBeenCalled();
    expect(bodies("/actions/x")[0]).toMatchObject({ response_type: "ephemeral" });
  });

  it("the Answer button opens a modal before the ack, carrying incidentId and factKey", async () => {
    expect((await post(factButton("fact_input", "processing_role", "U_DPO"))).status).toBe(200);
    const [open] = bodies("views.open");
    expect(open.trigger_id).toBe("trig.1");
    expect(JSON.parse(open.view.private_metadata)).toMatchObject({ incidentId: INCIDENT_ID, factKey: "processing_role" });
    expect(open.view.blocks[0].element).toMatchObject({ type: "static_select", action_id: "value" });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("a modal submission with an enum value sets and confirms the fact", async () => {
    const values = { value: { value: { type: "static_select", selected_option: { value: "processor" } } } };
    expect((await post(submit("U_DPO", "fact_input", { incidentId: INCIDENT_ID, factKey: "processing_role" }, values))).status).toBe(200);
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.facts.processing_role).toMatchObject({ value: "processor", state: "confirmed", method: "human", confirmedBy: "Claire Martin" });
    expect(arg.event).toMatchObject({ type: "answer", factKey: "processing_role", answer: "yes" });
    expect(arg.idempotencyKey).toBe("slack:V123:U_DPO");
  });

  it("a modal submission with an invalid value or by the wrong role is rejected in the modal, no write", async () => {
    const meta = { incidentId: INCIDENT_ID, factKey: "processing_role" };
    const bad = await post(submit("U_DPO", "fact_input", meta, { value: { value: { type: "static_select", selected_option: { value: "owner" } } } }));
    expect((await bad.json()).response_action).toBe("errors");
    const wrongRole = await post(submit("U_IT", "fact_input", meta, { value: { value: { type: "static_select", selected_option: { value: "processor" } } } }));
    expect((await wrongRole.json()).response_action).toBe("errors");
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("the DPO confirms the severity from the select; a non-DPO is refused with no write", async () => {
    const sev = (user: string) => action(user, { action_id: "severity", selected_option: { value: JSON.stringify({ incidentId: INCIDENT_ID, severity: "major" }) } });
    await post(sev("U_IT"));
    expect(m.recordEvent).not.toHaveBeenCalled();
    expect(bodies("/actions/x")[0]).toMatchObject({ response_type: "ephemeral" });
    await post(sev("U_DPO"));
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.event).toMatchObject({ type: "severity_confirmed", value: "major", by: { role: "dpo", name: "Claire Martin" } });
    expect(arg.idempotencyKey).toBe("slack:1790000000.123:U_DPO");
  });

  it("awareness: a non-DPO is refused; a time before the first signal comes back as an ephemeral error", async () => {
    const at = (user: string, iso: string) => action(user, { action_id: "awareness", block_id: `awareness:${INCIDENT_ID}`, selected_date_time: Date.parse(iso) / 1000 });
    await post(at("U_IT", "2026-10-04T10:00:00+02:00"));
    await post(at("U_DPO", "2026-10-01T10:00:00+02:00"));
    expect(m.recordEvent).not.toHaveBeenCalled();
    expect(bodies("/actions/x")[1].text).toContain("before the first signal");
    await post(at("U_DPO", "2026-10-04T10:00:00+02:00"));
    expect(m.recordEvent.mock.calls[0][0]).toMatchObject({ awarenessAt: "2026-10-04T08:00:00.000Z", event: { type: "awareness" } });
  });

  it("the Sign button opens the decision modal (no override checkbox unless needed)", async () => {
    await post(action("U_DPO", { action_id: "sign_decision:gdpr.notify_authority", value: JSON.stringify({ incidentId: INCIDENT_ID, obligationId: "gdpr.notify_authority" }) }));
    const [open] = bodies("views.open");
    expect(open.view.callback_id).toBe("sign_decision");
    expect(open.view.blocks.map((b: { block_id?: string }) => b.block_id).filter(Boolean)).toEqual(["choice", "reasons"]);
  });

  it("a non-DPO cannot sign a decision: modal error, no write", async () => {
    const res = await post(decision("U_IT", "A risk to customers is presumed, contact data was exported."));
    expect(await res.json()).toMatchObject({ response_action: "errors", errors: { reasons: expect.stringContaining("Only the DPO") } });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("a decision with short reasons comes back as a modal validation error", async () => {
    const res = await post(decision("U_DPO", "too short"));
    expect(await res.json()).toMatchObject({ response_action: "errors", errors: { reasons: expect.stringContaining("at least 20") } });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("a valid decision is recorded, then both drafts are recorded and posted to the DPO and the lawyer", async () => {
    expect((await post(decision("U_DPO", "A risk to customers is presumed, contact data was exported."))).status).toBe(200);
    const events = m.recordEvent.mock.calls.map((c) => c[0]);
    expect(events[0].event).toMatchObject({ type: "decision", obligationId: "gdpr.notify_authority", choice: "notify", by: { role: "dpo", name: "Claire Martin" } });
    expect(events.slice(1).map((e) => e.event)).toEqual([
      { type: "draft", document: "cnil_notification", status: "draft" },
      { type: "draft", document: "breach_register", status: "draft" },
    ]);
    expect(events[1].idempotencyKey).toBe(`${events[0].idempotencyKey}:draft:cnil_notification`);
    expect(bodies("conversations.open").map((b) => b.users).sort()).toEqual(["U_DPO", "U_LAW"]);
    const posts = bodies("chat.postMessage");
    expect(posts).toHaveLength(4);
    for (const p of posts) {
      expect(p.blocks.length).toBeLessThanOrEqual(50);
      for (const b of p.blocks) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(JSON.stringify(posts)).toContain("A phishing email led to the export");
  });

  it("view_submission payloads are signature-checked too", async () => {
    const body = decision("U_DPO", "A risk to customers is presumed, contact data was exported.");
    expect((await post(body, sign(body, Math.floor(Date.now() / 1000), "wrong"))).status).toBe(401);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("a non-boolean fact is not answerable by button", async () => {
    expect((await post(click("processing_role", "yes"))).status).toBe(400);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });
});
