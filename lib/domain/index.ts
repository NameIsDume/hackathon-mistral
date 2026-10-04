// Domain contracts shared by core and UI (PLAN.md, "Contrats minimums du MVP").
// No connector, LLM or Supabase type may leak in here.
import { z } from "zod";

export const Severity = z.enum(["false_positive", "minimal", "average", "major"]);
export type Severity = z.infer<typeof Severity>;

// Roles from the role matrix (Notion). A role never carries a Slack channel; routing resolves role -> person -> channel.
export const Role = z.enum(["reporter", "it", "business_owner", "dpo", "lawyer", "management", "communications"]);
export type Role = z.infer<typeof Role>;

export const Signal = z.object({
  id: z.uuid(),
  workspaceId: z.string().min(1),
  connectorId: z.string().min(1),
  externalId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  actor: z.string().min(1),
  content: z.string().min(1).max(4000),
  sourceRef: z.object({ url: z.url().optional(), excerpt: z.string().optional() }),
});
export type Signal = z.infer<typeof Signal>;

export const FactState = z.enum(["proposed", "confirmed", "disputed"]);
export const ExtractionMethod = z.enum(["llm", "human", "fixture"]);

export const FactSource = z.object({
  signalId: z.uuid().optional(),
  excerpt: z.string(),
});

// value === null means "unknown", which is distinct from false (R08).
export const fact = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    state: FactState,
    method: ExtractionMethod,
    sources: z.array(FactSource),
    confirmedBy: z.string().optional(),
    confirmedAt: z.iso.datetime({ offset: true }).optional(),
  });
const AnyFact = fact(z.unknown());
export type Fact<T> = Omit<z.infer<typeof AnyFact>, "value"> & { value: T | null };

export const IncidentSnapshot = z.object({
  id: z.uuid(),
  version: z.int().positive(),
  firstSignalAt: z.iso.datetime({ offset: true }),
  awarenessAt: z.iso.datetime({ offset: true }).nullable(),
  severity: fact(Severity),
  signalIds: z.array(z.uuid()),
  facts: z.record(z.string(), AnyFact),
});
export type IncidentSnapshot = z.infer<typeof IncidentSnapshot>;

export const ObligationStatus = z.enum(["required", "not_required", "undetermined"]);
export type ObligationStatus = z.infer<typeof ObligationStatus>;

export const Deadline = z.discriminatedUnion("policy", [
  z.object({ policy: z.literal("duration"), startEvent: z.literal("awareness"), hours: z.number().positive() }),
  z.object({ policy: z.literal("without_undue_delay"), startEvent: z.literal("awareness") }),
]);

export const Obligation = z.object({
  id: z.string(), // e.g. gdpr.notify_authority
  status: ObligationStatus,
  // "required" resting on facts not yet confirmed is shown as "required, facts to confirm" (R08 asymmetry).
  factsToConfirm: z.array(z.string()),
  reasons: z.array(z.string()),
  legalRefs: z.array(z.string()),
  citedFacts: z.array(z.string()),
  blockingQuestions: z.array(z.string()),
  deadline: Deadline.optional(),
});
export type Obligation = z.infer<typeof Obligation>;

export const Assessment = z.object({
  module: z.string(),
  moduleVersion: z.string(),
  factsVersion: z.int().positive(),
  applicability: z.enum(["applicable", "not_applicable", "unknown"]),
  obligations: z.array(Obligation),
});
export type Assessment = z.infer<typeof Assessment>;

export const Question = z.object({
  id: z.string(),
  factKey: z.string(),
  role: Role,
  text: z.string(),
});
export type Question = z.infer<typeof Question>;

export type RegulationModule = {
  id: string;
  version: string;
  facts: z.ZodObject;
  questions: Question[];
  evaluate(snapshot: IncidentSnapshot): Assessment;
};
