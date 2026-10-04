// GDPR fact catalogue: one entry per fact the rules need.
// Source of truth for the wording and routing: the fact table in the lawyers' workspace (Notion, owner: Charis).
// The extraction schema, the questions and the rules all derive from this one list.
import { z } from "zod";
import type { Question, Role } from "@/lib/domain";

type FactDef = {
  value: z.ZodType;
  role: Role; // who holds the answer
  question: string; // plain language, shown in the Slack DM
  decisiveFor: string[]; // obligation ids whose outcome can flip on this fact
};

export const GDPR_FACTS = {
  personal_data: {
    value: z.boolean(),
    role: "it",
    question: "Did the files or systems affected contain information about people?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects", "gdpr.record_breach"],
  },
  breach_type: {
    value: z.array(z.enum(["confidentiality", "integrity", "availability"])),
    role: "it",
    question: "Was data seen or taken, changed, or just made unavailable?",
    decisiveFor: ["gdpr.notify_authority"],
  },
  data_categories: {
    value: z.array(z.enum(["contact", "financial", "id_document", "credentials", "special_category", "other"])),
    role: "business_owner",
    question: "What kind of information was in it (contact details, bank data, health, ID)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  subjects_count: {
    value: z.int().nonnegative(),
    role: "business_owner",
    question: "Roughly how many people are concerned?",
    decisiveFor: [],
  },
  subjects_categories: {
    value: z.array(z.enum(["customers", "employees", "minors", "other"])),
    role: "business_owner",
    question: "Who are these people (customers, staff, children)?",
    decisiveFor: ["gdpr.inform_subjects"],
  },
  encrypted: {
    value: z.boolean(),
    role: "it",
    question: "Were the files encrypted?",
    decisiveFor: ["gdpr.inform_subjects"],
  },
  keys_safe: {
    value: z.boolean(),
    role: "it",
    question: "Is the encryption key or password still safe (not available to the attacker)?",
    decisiveFor: ["gdpr.inform_subjects"],
  },
  still_exposed: {
    value: z.boolean(),
    role: "it",
    question: "Is the data still accessible to the attacker?",
    decisiveFor: ["gdpr.inform_subjects"],
  },
  malicious: {
    value: z.boolean(),
    role: "it",
    question: "Was this a deliberate attack (not a mistake)?",
    decisiveFor: ["gdpr.notify_authority"],
  },
  measures_taken: {
    value: z.string(),
    role: "it",
    question: "What has been done so far to stop it?",
    decisiveFor: [],
  },
  processing_role: {
    value: z.enum(["controller", "processor"]),
    role: "dpo",
    question: "Is this our own data, or data we handle for a client?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.notify_controller"],
  },
  cross_border: {
    value: z.boolean(),
    role: "business_owner",
    question: "Are some of these people outside France?",
    decisiveFor: [],
  },
} satisfies Record<string, FactDef>;

export type GdprFactKey = keyof typeof GDPR_FACTS;

// Flat values object for LLM extraction: every fact optional-unknown (null).
export const GdprFactValues = z.object(
  Object.fromEntries(Object.entries(GDPR_FACTS).map(([k, d]) => [k, d.value.nullable()])) as {
    [K in GdprFactKey]: z.ZodNullable<(typeof GDPR_FACTS)[K]["value"]>;
  },
);
export type GdprFactValues = z.infer<typeof GdprFactValues>;

export const GDPR_QUESTIONS: Question[] = Object.entries(GDPR_FACTS).map(([key, d]) => ({
  id: `gdpr.${key}`,
  factKey: key,
  role: d.role,
  text: d.question,
}));
