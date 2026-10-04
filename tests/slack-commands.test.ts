import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./helpers/slack";

const m = vi.hoisted(() => ({ db: vi.fn(), ingestSignal: vi.fn(), afterIntake: vi.fn(), tasks: [] as (() => unknown)[] }));
vi.mock("@/lib/adapters/supabase", async (orig) => ({ ...(await orig<object>()), db: m.db }));
vi.mock("@/lib/services/ingest", async (orig) => ({ ...(await orig<object>()), ingestSignal: m.ingestSignal }));
vi.mock("@/lib/services/triggers", () => ({ afterIntake: m.afterIntake }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(fn) }));

import { POST } from "@/app/api/slack/commands/route";

const SECRET = "test-signing-secret";
const TRIGGER = "13345224609.738474920.8088930838d88f008e0";
const form = (text: string) =>
  new URLSearchParams({ command: "/incident", text, user_id: "U_TIM", user_name: "tim", trigger_id: TRIGGER, response_url: "https://hooks.slack.com/commands/x" }).toString();
const post = (body: string, secret = SECRET) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex") };
  return POST(new Request("http://localhost/api/slack/commands", { method: "POST", body, headers }));
};

describe("POST /api/slack/commands (/incident)", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    m.tasks.length = 0;
    m.db.mockImplementation(fakeDb({ people: [{ name: "Timothé", role: "dpo", slack_user_id: "U_TIM" }] }));
    m.ingestSignal.mockReset().mockResolvedValue({ status: "created", incidentId: "inc-1" });
    m.afterIntake.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401 on a bad signature, nothing scheduled", async () => {
    expect((await post(form("laptop stolen"), "wrong")).status).toBe(401);
    expect(m.tasks).toHaveLength(0);
  });

  it("empty text: ephemeral usage hint, no intake", async () => {
    const res = await post(form("   "));
    expect(await res.json()).toMatchObject({ response_type: "ephemeral", text: expect.stringContaining("Usage") });
    expect(m.tasks).toHaveLength(0);
    expect(m.ingestSignal).not.toHaveBeenCalled();
  });

  it("acks at once, then ingests as a Slack signal keyed by trigger_id and runs the DM wave", async () => {
    const res = await post(form("I lost a laptop with the HR export"));
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: "Received, the response team is being alerted." });
    expect(m.ingestSignal).not.toHaveBeenCalled(); // the ack does not wait for the intake
    expect(m.tasks).toHaveLength(1);
    await m.tasks[0]();
    expect(m.ingestSignal).toHaveBeenCalledWith({ text: "I lost a laptop with the HR export", externalId: TRIGGER, actor: "Timothé (slack:U_TIM)" }, "slack");
    expect(m.afterIntake).toHaveBeenCalledWith({ status: "created", incidentId: "inc-1" });
  });
});
