import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "@/lib/regulations/gdpr";
import { INCIDENT_ID, fakeDb, slackOk, snap } from "./helpers/slack";

// --- mocks ---------------------------------------------------------------
const m = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  recordEvent: vi.fn(async () => 6),
  listEvents: vi.fn(async () => []),
  db: vi.fn(),
  extractReplyFacts: vi.fn(),
  interpretCaseQuestion: vi.fn(),
  posts: [] as { channel: string; text: string; blocks: unknown[] }[],
  tasks: [] as Promise<unknown>[],
}));

vi.mock("@/lib/adapters/supabase", async (orig) => ({
  ...(await orig<object>()),
  db: m.db,
  loadSnapshot: m.loadSnapshot,
  recordEvent: m.recordEvent,
  listEvents: m.listEvents,
}));
vi.mock("@/lib/adapters/mistral", async (orig) => ({
  ...(await orig<object>()),
  extractReplyFacts: m.extractReplyFacts,
  interpretCaseQuestion: m.interpretCaseQuestion,
}));
vi.mock("@/lib/adapters/slack", async (orig) => ({
  ...(await orig<object>()),
  openDm: async () => "D_DPO",
  postDm: async (channel: string, blocks: unknown[], text: string) => {
    m.posts.push({ channel, blocks, text });
    return { channel, ts: String(1000 + m.posts.length) };
  },
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => m.tasks.push(Promise.resolve().then(fn)) }));

import { answerCaseQuestion, coerceValue, ingestReply } from "@/lib/services/slack-events";

const IT = { name: "Hugo Leroy", role: "it" as const, slackUserId: "U_IT" };
const flatten = (blocks: unknown[]) =>
  blocks.map((b) => (b as { text?: { text?: string } }).text?.text ?? "").join("\n");

type RecordArg = { event: { type: string; factKeys?: string[] }; facts: Record<string, { value: unknown; state: string }> };
const recordCalls = () => m.recordEvent.mock.calls as unknown as Array<[RecordArg]>;

beforeEach(() => {
  m.posts.length = 0;
  m.recordEvent.mockClear();
  m.db.mockReturnValue(fakeDb({ people: [{ name: "Claire Martin", role: "dpo", slack_user_id: "U_DPO" }] })());
});
afterEach(() => vi.restoreAllMocks());

describe("coerceValue", () => {
  it("coerces to the fact's real type or rejects", () => {
    expect(coerceValue("encrypted", "yes")).toBe(true);
    expect(coerceValue("encrypted", "non")).toBe(false);
    expect(coerceValue("encrypted", "maybe")).toBeNull();
    expect(coerceValue("subjects_count", "2 400")).toBe(2400);
    expect(coerceValue("breach_type", "confidentiality, availability")).toEqual(["confidentiality", "availability"]);
    expect(coerceValue("breach_type", "nonsense")).toBeNull();
  });
});

describe("free-text reply (#55)", () => {
  it("confirms several facts from one sentence", async () => {
    m.loadSnapshot.mockResolvedValue(snap({ personal_data: true }, "major"));
    m.extractReplyFacts.mockResolvedValue({
      still_exposed: { value: false, excerpt: "we blocked the account" },
      malicious: { value: true, excerpt: "it was a deliberate attack" },
    });

    await ingestReply(INCIDENT_ID, IT, "D_IT", "We blocked the account; it was a deliberate attack.");

    const extraction = recordCalls().find((c) => c[0].event.type === "extraction")![0];
    expect(extraction.event.factKeys).toEqual(["still_exposed", "malicious"]);
    expect(extraction.facts.still_exposed).toMatchObject({ value: false, state: "proposed" });
    expect(extraction.facts.malicious).toMatchObject({ value: true, state: "proposed" });
    // The person is offered a one-click confirm, and no contradiction was raised.
    expect(m.posts.some((p) => /noted 2 facts to confirm/.test(p.blocks && flatten(p.blocks as unknown[])))).toBe(true);
    expect(m.posts.some((p) => p.channel === "D_DPO")).toBe(false);
  });

  it("flags a contradiction and alerts the DPO", async () => {
    const s = snap({ personal_data: true }, "major");
    s.facts.personal_data = { value: true, state: "confirmed", method: "human", sources: [], confirmedBy: "Nadia" };
    m.loadSnapshot.mockResolvedValue(s);
    m.extractReplyFacts.mockResolvedValue({ personal_data: { value: false, excerpt: "no personal data was involved" } });

    await ingestReply(INCIDENT_ID, IT, "D_IT", "Actually there was no personal data involved.");

    const extraction = recordCalls().find((c) => c[0].event.type === "extraction")![0];
    expect(extraction.facts.personal_data.state).toBe("disputed"); // counts as unknown in the rules
    const alert = m.posts.find((p) => p.channel === "D_DPO");
    expect(alert).toBeTruthy();
    expect(flatten(alert!.blocks as unknown[])).toMatch(/Contradiction/);
  });
});

describe('"what if" is computed by the rules, not the model (#55)', () => {
  it("matches evaluate() on the modified snapshot", async () => {
    const base = snap({ personal_data: true, breach_type: ["confidentiality"], data_categories: ["special_category"] }, "major");
    m.loadSnapshot.mockResolvedValue(base);
    m.interpretCaseQuestion.mockResolvedValue({
      kind: "what_if",
      overrides: [
        { factKey: "encrypted", value: "yes" },
        { factKey: "keys_safe", value: "yes" },
      ],
    });

    await answerCaseQuestion(INCIDENT_ID, "D_DPO", "and if the data were encrypted and the keys safe?");

    // Independently compute the expected result with the real rules on the same hypothetical snapshot.
    const hypo = structuredClone(base);
    hypo.facts.encrypted = { value: true, state: "confirmed", method: "human", sources: [] };
    hypo.facts.keys_safe = { value: true, state: "confirmed", method: "human", sources: [] };
    const after = evaluate(hypo);
    const msg = flatten(m.posts.at(-1)!.blocks as unknown[]);
    for (const o of after.obligations) expect(msg).toContain(o.status.replaceAll("_", " "));
  });
});

describe("/api/slack/events route", () => {
  const SECRET = "test-signing-secret";
  const sign = (body: string, ts = 1_790_000_000) => ({
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex"),
    "content-type": "application/json",
  });

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    vi.useFakeTimers().setSystemTime(1_790_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("answers the url_verification challenge", async () => {
    const { POST } = await import("@/app/api/slack/events/route");
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await POST(new Request("http://x/api/slack/events", { method: "POST", body, headers: sign(body) }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("rejects a bad signature", async () => {
    const { POST } = await import("@/app/api/slack/events/route");
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await POST(
      new Request("http://x/api/slack/events", { method: "POST", body, headers: { ...sign(body), "x-slack-signature": "v0=bad" } }),
    );
    expect(res.status).toBe(401);
  });
});

void slackOk;
