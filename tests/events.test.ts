import { describe, expect, it } from "vitest";
import { IncidentEvent } from "@/lib/domain";

const dpo = { role: "dpo", name: "Claire Martin", slackUserId: "U123" } as const;

describe("IncidentEvent", () => {
  it("accepts a Slack DM notification and an answer", () => {
    expect(
      IncidentEvent.parse({
        type: "notification",
        to: { role: "it", name: "Hugo Leroy" },
        kind: "questions",
        questionIds: ["gdpr.encrypted"],
        preview: "Were the files encrypted?",
        slack: { channel: "D1", ts: "1700000000.0001" },
        delivered: true,
      }).type,
    ).toBe("notification");
    expect(IncidentEvent.parse({ type: "answer", by: dpo, factKey: "processing_role", answer: "yes", via: "slack" }).type).toBe("answer");
  });
  it("rejects an unknown event type or role", () => {
    expect(IncidentEvent.safeParse({ type: "gossip" }).success).toBe(false);
    expect(
      IncidentEvent.safeParse({ type: "answer", by: { ...dpo, role: "intern" }, factKey: "x", answer: "yes", via: "slack" }).success,
    ).toBe(false);
  });
});
