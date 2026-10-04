import { describe, expect, it } from "vitest";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { deriveColumns, formatDue, isOverdue, reporterName } from "@/lib/dashboard/tasks";
import type { EventRow } from "@/lib/dashboard/view";

const it_ = { role: "it" as const, name: "Timothé" };
const dpo = { role: "dpo" as const, name: "Cécile" };
const lawyer = { role: "lawyer" as const, name: "Martyna" };
const base = { at: "2026-10-04T14:25:00.000Z", actor: "core", slack: null, delivered: true, preview: "" };
const fact = (value: unknown, state: "proposed" | "confirmed"): Fact<unknown> => ({ value, state, method: "llm", sources: [] });
const obligation = (id: string, status: Obligation["status"]): Obligation => ({
  id, status, factsToConfirm: [], reasons: [], legalRefs: [], citedFacts: [], blockingQuestions: [],
});

const events: EventRow[] = [
  { ...base, id: 1, type: "notification", to: it_, kind: "questions", questionIds: ["gdpr.personal_data", "gdpr.encrypted", "gdpr.malicious"] },
  { ...base, id: 2, type: "notification", to: dpo, kind: "assessment", questionIds: ["gdpr.processing_role"] },
  { ...base, id: 3, type: "notification", to: lawyer, kind: "assessment", questionIds: [] },
  { ...base, id: 4, type: "decision", stage: "recommendation", by: dpo, obligationId: "gdpr.notify_authority", choice: "notify", reasons: "r", factsVersion: 1, moduleVersion: "1" },
];
const severity: Fact<Severity> = { value: "major", state: "proposed", method: "llm", sources: [] };
const facts = { personal_data: fact(true, "confirmed"), encrypted: fact(false, "proposed"), malicious: fact(null, "proposed") };
const obligations = [obligation("gdpr.notify_authority", "required"), obligation("gdpr.inform_subjects", "not_required"), obligation("gdpr.record_breach", "required")];

describe("who does what", () => {
  const cols = deriveColumns(events, obligations, severity, facts);
  const col = (role: string) => cols.find((c) => c.role === role)!;
  const task = (role: string, id: string) => col(role).tasks.find((t) => t.id === id)!;

  it("gives severity and awareness to the DPO, with T+1h, and puts the DPO first", () => {
    expect(cols.map((c) => c.role)).toEqual(["dpo", "it", "lawyer"]);
    expect(task("dpo", "severity")).toMatchObject({ due: 1, status: "in_progress" });
    expect(col("it").tasks.some((t) => t.id === "severity")).toBe(false);
  });

  it("titles questions in plain language and derives their status from the facts", () => {
    expect(col("it").tasks.map((t) => [t.title, t.status, t.due])).toEqual([
      ["Did the files or systems affected contain information about real people?", "done", 12],
      ["Were the files encrypted?", "in_progress", 12],
      ["Was this a deliberate attack (not a mistake)?", "todo", 12],
    ]);
    expect(cols.flatMap((c) => c.tasks.map((t) => t.title)).join(" ")).not.toMatch(/gdpr\.|_/);
  });

  it("dates sign-off and documents, and only for obligations that ask something of us", () => {
    expect(task("dpo", "rec-gdpr.notify_authority")).toMatchObject({ due: 24, status: "done" });
    expect(task("lawyer", "dec-gdpr.notify_authority")).toMatchObject({ due: 48, status: "pending_validation" });
    expect(task("dpo", "cnil")).toMatchObject({ due: 72, status: "todo" });
    expect(formatDue(task("dpo", "register").due)).toBe("ongoing");
    expect(col("lawyer").tasks.some((t) => t.id.includes("inform_subjects"))).toBe(false);
  });

  it("flags a task late against its relative deadline, never a done one", () => {
    const start = Date.parse(base.at);
    expect(isOverdue(task("dpo", "severity"), start, start + 2 * 3_600_000)).toBe(true);
    expect(isOverdue(task("it", "q-gdpr.personal_data"), start, start + 13 * 3_600_000)).toBe(false);
    expect(formatDue(12)).toBe("T+12h");
  });
});

it("puts whoever ran /incident first, as the reporter, with the report done", () => {
  const events = [{ id: 1, at: "2026-10-04T14:25:13Z", actor: "Wael Ben Slima (slack:U0C6)", type: "signal", signalId: "6f1c1b7e-0a7b-4a5e-9d4f-0f3b3c2a1d10", connectorId: "slack", excerpt: "x" }] as never;
  expect(reporterName("Wael Ben Slima (slack:U0C6)")).toBe("Wael Ben Slima");
  const [first] = deriveColumns(events, [], { value: null, state: "proposed", method: "llm", sources: [] }, {});
  expect(first).toMatchObject({ role: "reporter", name: "Wael Ben Slima", done: 1, total: 1 });
});

it("a lawyer's follow-up question: the DPO has to answer it, the lawyer waits (orange) until the reply", () => {
  const sev = { value: null, state: "proposed", method: "llm", sources: [] } as never;
  const n = (id: number, at: string, to: { role: string; name: string }, preview: string) =>
    ({ id, at, actor: "x", type: "notification", to, kind: "decision", questionIds: [], preview, slack: null, delivered: true }) as never;
  const ask = n(1, "2026-10-04T15:12:00Z", { role: "dpo", name: "Cécile von Roenne" }, "*Follow-up question from Martyna Sieczka (lawyer):*\nWhat data?");
  const law = n(0, "2026-10-04T15:00:00Z", { role: "lawyer", name: "Martyna Sieczka" }, "case");
  const task = (cols: ReturnType<typeof deriveColumns>, role: string) => cols.find((c) => c.role === role)!.tasks.find((t) => /question|answer/.test(t.title))!;
  let cols = deriveColumns([law, ask], [], sev, {});
  expect(task(cols, "dpo")).toMatchObject({ title: "Answer Martyna's question", status: "todo" });
  expect(task(cols, "lawyer")).toMatchObject({ title: "Waiting for Cécile's answer", status: "pending_validation" });
  const reply = n(2, "2026-10-04T15:20:00Z", { role: "lawyer", name: "Martyna Sieczka" }, "*Reply from Cécile von Roenne (DPO):*\nContact details.");
  cols = deriveColumns([law, ask, reply], [], sev, {});
  expect(task(cols, "dpo").status).toBe("done");
  expect(task(cols, "lawyer").status).toBe("done");
});
