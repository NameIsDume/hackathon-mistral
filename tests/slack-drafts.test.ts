// Draft actions from Slack (#49): "Approve section" (lawyer) and "Mark as sent" (DPO), through the signed route.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn(), listEvents: vi.fn(), tasks: [] as Promise<unknown>[] }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({
  ...(await orig<object>()),
  db: m.db,
  loadSnapshot: m.loadSnapshot,
  recordEvent: m.recordEvent,
  listEvents: m.listEvents,
}));
vi.mock("@/lib/adapters/mistral", () => ({ draftNarrative: async () => null }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(Promise.resolve().then(fn)) }));

import { POST } from "@/app/api/slack/interactions/route";

const PEOPLE = [
  { name: "Claire Martin", role: "dpo", slack_user_id: "U_DPO" },
  { name: "Inès Haddad", role: "lawyer", slack_user_id: "U_LAW" },
];
const SECRET = "test-signing-secret";
const lawyer = { role: "lawyer" as const, name: "Inès Haddad", slackUserId: "U_LAW" };
const AI = { at: "2026-10-04T11:30:00+02:00", actor: "system", event: { type: "draft", document: "cnil_notification", status: "draft", ai: { consequences: "AI consequences.", measures: "AI measures." } } };
const approved = (section: string) => ({
  at: "2026-10-04T12:00:00+02:00",
  actor: "slack:U_LAW",
  event: { type: "draft", document: "cnil_notification", status: "section_approved", section, text: `Lawyer ${section}.`, by: lawyer },
});

const form = (payload: object) => "payload=" + encodeURIComponent(JSON.stringify(payload));
const sign = (body: string) => {
  const ts = Math.floor(Date.now() / 1000);
  return new Headers({ "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") });
};
const click = (user: string, action_id: string, value: object) =>
  form({
    type: "block_actions",
    user: { id: user },
    trigger_id: "trig.1",
    actions: [{ action_id, action_ts: "1790000000.123", value: JSON.stringify({ incidentId: INCIDENT_ID, ...value }) }],
    container: { channel_id: "D1", message_ts: "1.1" },
  });
const submit = (user: string, callback_id: string, meta: object, values: object) =>
  form({
    type: "view_submission",
    user: { id: user },
    view: { id: "V123", callback_id, private_metadata: JSON.stringify({ incidentId: INCIDENT_ID, channel: "D1", ...meta }), state: { values } },
  });
const approve = (user: string, text: string) => submit(user, "draft_approve_section", { section: "consequences" }, { text: { text: { type: "plain_text_input", value: text } } });
const SENT_AT = 1_791_100_000; // 2026-10-04T07:46:40Z, before the faked clock
const markSent = (user: string, reference?: string) =>
  submit(user, "draft_mark_sent", {}, {
    sent_at: { sent_at: { type: "datetimepicker", selected_date_time: SENT_AT } },
    reference: { reference: { type: "plain_text_input", value: reference ?? null } },
  });

async function post(body: string) {
  const res = await POST(new Request("http://localhost/api/slack/interactions", { method: "POST", body, headers: sign(body) }));
  await Promise.all(m.tasks.splice(0));
  return res;
}

describe("draft actions in Slack", () => {
  let fetch: MockInstance<typeof globalThis.fetch>;
  const bodies = (method: string) => fetch.mock.calls.filter((c) => String(c[0]).endsWith(method)).map((c) => JSON.parse(c[1]!.body as string));
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00Z"), toFake: ["Date"] });
    m.recordEvent.mockReset().mockResolvedValue(6);
    m.loadSnapshot.mockImplementation(async () => snap(NUVOLA));
    m.listEvents.mockResolvedValue([AI]);
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
    fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => slackOk({ channel: "D1", ts: "9.9" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("'Approve section' opens a modal pre-filled with the AI first pass", async () => {
    expect((await post(click("U_LAW", "draft_approve_section:consequences", { section: "consequences" }))).status).toBe(200);
    const [open] = bodies("views.open");
    expect(open.view.callback_id).toBe("draft_approve_section");
    expect(open.view.blocks[1].element.initial_value).toBe("AI consequences.");
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("only the lawyer can approve a section", async () => {
    const res = await post(approve("U_DPO", "Customers may receive phishing emails."));
    expect(await res.json()).toMatchObject({ response_action: "errors", errors: { text: expect.stringContaining("Only the lawyer") } });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("the lawyer's edited text is recorded as section_approved, with an idempotency key from the Slack view", async () => {
    expect((await post(approve("U_LAW", "  Customers may receive phishing emails. "))).status).toBe(200);
    await post(approve("U_LAW", "Customers may receive phishing emails.")); // Slack replays the same submission
    const calls = m.recordEvent.mock.calls.map((c) => c[0]);
    expect(calls[0].event).toEqual({
      type: "draft",
      document: "cnil_notification",
      status: "section_approved",
      section: "consequences",
      text: "Customers may receive phishing emails.",
      by: lawyer,
    });
    expect(calls[0].idempotencyKey).toBe("slack:V123:U_LAW");
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect(bodies("chat.postMessage")[0].text).toMatch(/Not ready to send yet/);
  });

  it("an empty approval is refused in the modal", async () => {
    expect(await (await post(approve("U_LAW", "   "))).json()).toMatchObject({ response_action: "errors" });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("only the DPO can mark as sent", async () => {
    m.listEvents.mockResolvedValue([AI, approved("consequences"), approved("measures")]);
    const res = await post(markSent("U_LAW", "CNIL-1"));
    expect(await res.json()).toMatchObject({ errors: { sent_at: expect.stringContaining("Only the DPO") } });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("'Mark as sent' is refused before the lawyer approved both sections", async () => {
    m.listEvents.mockResolvedValue([AI, approved("consequences")]);
    expect(await (await post(markSent("U_DPO", "CNIL-1"))).json()).toMatchObject({ errors: { sent_at: expect.stringContaining("Not ready to send") } });
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("the DPO records the transmission with its time and CNIL reference", async () => {
    m.listEvents.mockResolvedValue([AI, approved("consequences"), approved("measures")]);
    expect((await post(markSent("U_DPO", " CNIL-2026-123 "))).status).toBe(200);
    const [call] = m.recordEvent.mock.calls.map((c) => c[0]);
    expect(call.event).toEqual({
      type: "draft",
      document: "cnil_notification",
      status: "sent",
      sentAt: new Date(SENT_AT * 1000).toISOString(),
      reference: "CNIL-2026-123",
      by: { role: "dpo", name: "Claire Martin", slackUserId: "U_DPO" },
    });
    expect(call.idempotencyKey).toBe("slack:V123:U_DPO");
  });
});
