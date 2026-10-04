import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { IncidentSnapshot } from "@/lib/domain";
import { evaluate } from "@/lib/regulations/gdpr";
import { GDPR_FACTS } from "@/lib/regulations/gdpr/facts";
import { INCIDENT_ID, NUVOLA, fakeDb, slackOk, snap } from "./helpers/slack";
type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const m = vi.hoisted(() => ({
  db: vi.fn(),
  loadSnapshot: vi.fn(),
  recordEvent: vi.fn(),
  listEvents: vi.fn(),
  tasks: [] as Promise<unknown>[],
  reply: (async () => "") as (opts: CallOptions) => Promise<string>,
  calls: [] as CallOptions[],
}));
vi.mock("@/lib/adapters/supabase", async (orig) => ({ ...(await orig<object>()), db: m.db, loadSnapshot: m.loadSnapshot, recordEvent: m.recordEvent, listEvents: m.listEvents }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(Promise.resolve().then(fn)) }));
vi.mock("@ai-sdk/mistral", () => ({
  mistral: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doGenerate: async (opts) => {
        m.calls.push(opts);
        return {
          content: [{ type: "text", text: await m.reply(opts) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        };
      },
    }),
}));

import { POST as events } from "@/app/api/slack/events/route";
import { POST as interactions } from "@/app/api/slack/interactions/route";

const SECRET = "test-signing-secret";
const PEOPLE = [
  { name: "Claire Martin", role: "dpo", slack_user_id: "U_DPO" },
  { name: "Hugo Leroy", role: "it", slack_user_id: "U_IT" },
  { name: "Inès Haddad", role: "lawyer", slack_user_id: "U_LAW" },
];
const IT_KEYS = Object.keys(GDPR_FACTS).filter((k) => GDPR_FACTS[k as keyof typeof GDPR_FACTS].role === "it");
// The person was DMed about the incident: that is how their message is tied to it.
const NOTES = PEOPLE.map((p, i) => ({ id: i, incident_id: INCIDENT_ID, type: "notification", at: "2026-10-04T10:00:00Z", "payload->to->>slackUserId": p.slack_user_id, payload: { slack: { ts: `1.${i}` } } }));

const sign = (body: string, secret = SECRET, extra: Record<string, string> = {}) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex"), ...extra });
};
async function postEvent(payload: object, opts: { secret?: string; headers?: Record<string, string> } = {}) {
  const body = JSON.stringify(payload);
  const res = await events(new Request("http://localhost/api/slack/events", { method: "POST", body, headers: sign(body, opts.secret, opts.headers) }));
  await Promise.all(m.tasks.splice(0));
  return res;
}
const dm = (user: string, text: string, extra: object = {}) => ({ type: "event_callback", event: { type: "message", channel_type: "im", user, text, channel: "D_" + user, ts: "100.1", ...extra } });

// The model's JSON for a free-text extraction: every fact of the schema present, null unless given.
const answerJson = (facts: Record<string, [unknown, string]>, followUp: string | null = null, keys = IT_KEYS) =>
  JSON.stringify({ facts: Object.fromEntries(keys.map((k) => [k, { value: facts[k]?.[0] ?? null, excerpt: facts[k]?.[1] ?? null }])), followUp });

describe("conversation in the DM (#55)", () => {
  let fetch: MockInstance<typeof globalThis.fetch>;
  let state: IncidentSnapshot;
  const bodies = (method: string) => fetch.mock.calls.filter((c) => String(c[0]).endsWith(method)).map((c) => JSON.parse(c[1]!.body as string));
  const posted = () => bodies("chat.postMessage");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:00+02:00"));
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    state = snap(NUVOLA);
    m.calls = [];
    m.reply = async () => {
      throw new Error("model not expected");
    };
    // A stateful incident: each recorded event applies its facts and bumps the version.
    m.loadSnapshot.mockImplementation(async () => structuredClone(state));
    m.recordEvent.mockReset().mockImplementation(async (a) => {
      if (a.facts) {
        const { severity, ...facts } = a.facts;
        state = { ...state, severity: severity ?? state.severity, facts };
      }
      return ++state.version;
    });
    m.listEvents.mockResolvedValue([]);
    m.db.mockImplementation(fakeDb({ people: PEOPLE, incident_events: NOTES }));
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => (String(url).endsWith("conversations.open") ? slackOk({ channel: { id: "D_ALERT" } }) : slackOk({ channel: "D9", ts: "9.9" })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("/api/slack/events", () => {
    it("answers url_verification with the challenge", async () => {
      const res = await postEvent({ type: "url_verification", challenge: "abc123" });
      expect(await res.json()).toEqual({ challenge: "abc123" });
    });

    it("401 on a bad signature, nothing scheduled", async () => {
      const res = await postEvent(dm("U_IT", "The export was not encrypted."), { secret: "wrong" });
      expect(res.status).toBe(401);
      expect(m.tasks).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("ignores Slack retries", async () => {
      expect((await postEvent(dm("U_IT", "The export was not encrypted."), { headers: { "x-slack-retry-num": "1" } })).status).toBe(200);
      expect(m.calls).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("ignores bot messages and subtypes (edits, our own replies)", async () => {
      await postEvent(dm("U_IT", "I understood: encrypted = No", { bot_id: "B1" }));
      await postEvent(dm("U_IT", "edited", { subtype: "message_changed" }));
      expect(m.calls).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("ignores someone who is not in the org chart", async () => {
      await postEvent(dm("U_STRANGER", "The export was not encrypted."));
      expect(m.calls).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("free-text answers", () => {
    const TEXT = "The export was not encrypted and the attacker can still reach the share.";

    it("extracts only the facts IT holds, only with excerpts quoted from the message, and writes nothing yet", async () => {
      m.reply = async () =>
        answerJson({
          encrypted: [false, "the export was not encrypted"],
          still_exposed: [true, "the attacker can still reach the share"],
          keys_safe: [true, "the keys are safe"], // not in the message: dropped
        });
      await postEvent(dm("U_IT", TEXT));
      const schema = JSON.stringify(m.calls[0].responseFormat);
      expect(schema).toContain('"still_exposed"');
      expect(schema).not.toContain('"processing_role"'); // the DPO's fact
      expect(schema).not.toContain('"subjects_count"'); // the business owner's fact
      const [reply] = posted();
      expect(reply.thread_ts).toBe("100.1");
      expect(reply.text).toBe('I understood: encrypted = No ("the export was not encrypted"), still_exposed = Yes ("the attacker can still reach the share")');
      expect(reply.text).not.toContain("keys_safe");
      expect(reply.blocks[1].elements.map((e: { action_id: string }) => e.action_id)).toEqual(["convo_confirm", "convo_edit"]);
      expect(m.recordEvent).not.toHaveBeenCalled();
    });

    it("a hedged answer gets a targeted follow-up question, no fact and no write", async () => {
      m.reply = async () => answerJson({ encrypted: [true, "it was encrypted"] }); // the model ignored the hedge
      await postEvent(dm("U_IT", "I think it was encrypted"));
      const [reply] = posted();
      expect(reply.text).toBe(`_To be sure: ${GDPR_FACTS.encrypted.question}_`);
      expect(JSON.stringify(reply.blocks)).not.toContain("convo_confirm");
      expect(m.recordEvent).not.toHaveBeenCalled();
    });

    const confirmAll = (user = "U_IT", f: [string, unknown, string][] = [["encrypted", false, "the export was not encrypted"], ["still_exposed", true, "the attacker can still reach the share"]]) => {
      const payload = {
        type: "block_actions",
        user: { id: user },
        actions: [{ action_id: "convo_confirm", action_ts: "200.1", value: JSON.stringify({ i: INCIDENT_ID, f }) }],
        container: { channel_id: "D_IT", message_ts: "9.9" },
      };
      return "payload=" + encodeURIComponent(JSON.stringify(payload));
    };
    const click = async (body: string) => {
      const res = await interactions(new Request("http://localhost/api/slack/interactions", { method: "POST", body, headers: sign(body) }));
      await Promise.all(m.tasks.splice(0));
      return res;
    };

    it("Confirm all records each fact confirmed by that person, one answer event each, once", async () => {
      state = snap({ ...NUVOLA, encrypted: null }); // nothing known yet about encryption
      expect((await click(confirmAll())).status).toBe(200);
      expect(m.recordEvent).toHaveBeenCalledTimes(2);
      const [first, second] = m.recordEvent.mock.calls.map((c) => c[0]);
      expect(first.facts.encrypted).toMatchObject({ value: false, state: "confirmed", method: "human", confirmedBy: "Hugo Leroy", sources: [{ excerpt: "the export was not encrypted" }] });
      expect(first.event).toEqual({ type: "answer", by: { role: "it", name: "Hugo Leroy", slackUserId: "U_IT" }, factKey: "encrypted", answer: "no", via: "slack" });
      expect(second.event).toMatchObject({ factKey: "still_exposed", answer: "yes" });
      expect(first.idempotencyKey).toBe("convo:D_IT:9.9:encrypted");
      expect(bodies("chat.update")[0]).toMatchObject({ channel: "D_IT", ts: "9.9", text: "Confirmed: encrypted = No, still_exposed = Yes." });

      await click(confirmAll()); // replayed click: nothing new to write
      expect(m.recordEvent).toHaveBeenCalledTimes(2);
    });

    it("someone without the role cannot confirm", async () => {
      await click(confirmAll("U_LAW"));
      expect(m.recordEvent).not.toHaveBeenCalled();
    });

    it("a contradiction makes the fact disputed, keeps both versions and alerts the DPO", async () => {
      state.facts.encrypted = { value: true, state: "proposed", method: "llm", sources: [{ excerpt: "files were encrypted" }] };
      await click(confirmAll("U_IT", [["encrypted", false, "the export was not encrypted"]]));
      const write = m.recordEvent.mock.calls[0][0];
      expect(write.facts.encrypted).toMatchObject({
        value: true,
        state: "disputed",
        sources: [{ excerpt: "files were encrypted" }, { excerpt: 'Hugo Leroy: No ("the export was not encrypted")' }],
      });
      const alert = posted().find((b) => b.channel === "D_ALERT");
      expect(alert.text).toContain("Contradiction");
      expect(alert.text).toContain('"files were encrypted"');
      expect(alert.text).toContain('Hugo Leroy: No ("the export was not encrypted")');
      expect(bodies("conversations.open")[0]).toEqual({ users: "U_DPO" });
      expect(m.recordEvent.mock.calls.at(-1)![0].event).toMatchObject({ type: "notification", to: { role: "dpo", slackUserId: "U_DPO" }, delivered: true });
    });
  });

  describe("questions", () => {
    it("what-if: the answer is evaluate() on a modified copy, and nothing is written", async () => {
      const overrides = { encrypted: true, encryption_state_of_art: true, keys_safe: true, encryption_covers_copies: true, backup_exists: true };
      m.reply = async () => JSON.stringify({ overrides: { ...Object.fromEntries(Object.keys(GDPR_FACTS).map((k) => [k, null])), ...overrides } });
      await postEvent(dm("U_DPO", "What if the files were encrypted to current standards, the keys were safe, copies covered and we have a backup?"));
      const text = posted()[0].text as string;

      const copy = structuredClone(state);
      for (const [k, value] of Object.entries(overrides)) copy.facts[k] = { value, state: "confirmed", method: "human", sources: [] };
      const now = evaluate(copy).obligations.find((o) => o.id === "gdpr.notify_authority")!.status;
      const was = evaluate(state).obligations.find((o) => o.id === "gdpr.notify_authority")!.status;
      expect([now, was]).toEqual(["not_required", "required"]);
      expect(text).toContain("Notify the data protection authority (CNIL) → *not required* (was required)");
      // Every obligation's line shows the status evaluate() gives on the copy.
      for (const o of evaluate(copy).obligations) expect(text).toContain(`→ *${o.status.replaceAll("_", " ")}*`);
      expect(text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(evaluate(copy).obligations.length);
      expect(m.recordEvent).not.toHaveBeenCalled();
    });

    it("explains from the case data; the statuses shown come from the rules", async () => {
      m.reply = async () => JSON.stringify({ answer: "Because no exception is established on confirmed facts (para 119)." });
      await postEvent(dm("U_LAW", "Why is CNIL required?"));
      const prompt = JSON.stringify(m.calls[0].prompt);
      expect(prompt).toContain("legal_decisions");
      expect(prompt).toContain("Q6 Encryption exception");
      expect(posted()[0].text).toContain("Notify the data protection authority (CNIL): *required*");
      expect(m.recordEvent).not.toHaveBeenCalled();
    });

    it("IT cannot use the questions: no model call", async () => {
      await postEvent(dm("U_IT", "Why is CNIL required?"));
      expect(m.calls).toHaveLength(0);
      expect(posted()[0].text).toContain("for the DPO and the lawyer");
    });
  });
});
