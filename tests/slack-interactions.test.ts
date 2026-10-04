import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { verifySlackSignature } from "@/lib/adapters/slack";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), loadSnapshot: vi.fn(), recordEvent: vi.fn(), tasks: [] as Promise<unknown>[] }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({ ...(await orig<object>()), db: m.db, loadSnapshot: m.loadSnapshot, recordEvent: m.recordEvent }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(Promise.resolve().then(fn)) }));

import { POST } from "@/app/api/slack/interactions/route";

const PEOPLE = [
  { name: "Claire Martin", role: "dpo", slack_user_id: "U_DPO" },
  { name: "Hugo Leroy", role: "it", slack_user_id: "U_IT" },
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

const click = (factKey = "encrypted", answer = "no", actionTs = "1790000000.123") =>
  "payload=" +
  encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      user: { id: "U_IT" },
      actions: [{ value: JSON.stringify({ incidentId: INCIDENT_ID, factKey, answer }), action_ts: actionTs }],
      container: { channel_id: "D1", message_ts: "1.1" },
      message: { blocks: [{ type: "section" }, { type: "actions", block_id: factKey }] },
      response_url: "https://hooks.slack.com/actions/x",
    }),
  );

async function post(body: string, headers = sign(body, Math.floor(Date.now() / 1000))) {
  const res = await POST(new Request("http://localhost/api/slack/interactions", { method: "POST", body, headers }));
  await Promise.all(m.tasks.splice(0));
  return res;
}

describe("POST /api/slack/interactions", () => {
  let fetch: MockInstance<typeof globalThis.fetch>;
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    m.recordEvent.mockReset().mockResolvedValue(6);
    m.loadSnapshot.mockResolvedValue(snap(NUVOLA));
    fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => slackOk());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects an invalid signature with 401 and does nothing", async () => {
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
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
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
    expect((await post(click("encrypted", "no"))).status).toBe(200);
    expect(m.recordEvent).toHaveBeenCalledTimes(1);
    const arg = m.recordEvent.mock.calls[0][0];
    expect(arg.expectedVersion).toBe(5);
    expect(arg.facts.encrypted).toMatchObject({ value: false, state: "confirmed", method: "human", confirmedBy: "Hugo Leroy" });
    expect(arg.facts.severity).toMatchObject({ value: "average" }); // record_event replaces the whole facts object
    expect(arg.facts.processing_role.value).toBe("controller");
    expect(arg.event).toEqual({ type: "answer", by: { role: "it", name: "Hugo Leroy", slackUserId: "U_IT" }, factKey: "encrypted", answer: "no", via: "slack" });
    const update = fetch.mock.calls.find((c) => String(c[0]).endsWith("chat.update"))!;
    expect(JSON.parse(update[1]!.body as string)).toMatchObject({ channel: "D1", ts: "1.1", text: "Answer recorded: No" });
  });

  it("a replayed action carries the same idempotency key", async () => {
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
    await post(click());
    await post(click());
    const keys = m.recordEvent.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual(["slack:1790000000.123:U_IT", "slack:1790000000.123:U_IT"]);
  });

  it("a non-boolean fact is not answerable by button", async () => {
    m.db.mockImplementation(fakeDb({ people: PEOPLE }));
    expect((await post(click("processing_role", "yes"))).status).toBe(400);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });
});
