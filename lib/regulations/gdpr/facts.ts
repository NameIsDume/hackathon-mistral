// GDPR fact catalogue: one entry per fact the rules need.
// Source of truth for the wording and routing: the fact table in the lawyers' workspace (Notion, owner: Charis),
// copied in docs/legal/decisions-2026-10-04.md ("Facts"). Existing keys are stable: they are stored in incident_events.
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
    question: "Did the files or systems affected contain information about real people?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects", "gdpr.record_breach"],
  },
  breach_type: {
    value: z.array(z.enum(["confidentiality", "integrity", "availability"])),
    role: "it",
    question: "Was data seen or taken, changed, or just made unavailable?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
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
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  keys_safe: {
    value: z.boolean(),
    role: "it",
    question: "Is the encryption key or password still safe (not compromised and not obtainable by the attacker)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  still_exposed: {
    value: z.boolean(),
    role: "it",
    question: "Is the data still accessible to the attacker?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  malicious: {
    value: z.boolean(),
    role: "it",
    question: "Was this a deliberate attack (not a mistake)?",
    decisiveFor: [], // aggravating factor shown to the lawyer (Q5), never flips an outcome alone
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
    question: "Do we decide why and how this data is used, or do we only handle it on someone else's instructions (for a client)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.notify_controller", "gdpr.inform_subjects"],
  },
  cross_border: {
    value: z.boolean(),
    role: "business_owner",
    question: "Do we have offices in other EEA countries (EU, Iceland, Liechtenstein, Norway), or does this substantially affect people living in them?",
    decisiveFor: [],
  },
  // --- Added from the lawyers' decisions of 2026-10-04 ---
  records_count: {
    value: z.int().nonnegative(),
    role: "business_owner",
    question: "Roughly how many records (rows, files, entries) are concerned? An estimate is fine for now.",
    decisiveFor: [], // content of the notification, Art. 33(3)(a); confirmed figure needed before the register entry is complete
  },
  encryption_state_of_art: {
    value: z.boolean(),
    role: "it",
    question: "Did the encryption meet current standards, and was it switched on at the time of the incident?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q6 condition 1
  },
  encryption_covers_copies: {
    value: z.boolean(),
    role: "it",
    question: "Did the encryption also cover the specific copies concerned (exports, backups)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q6 condition 3
  },
  backup_exists: {
    value: z.boolean(),
    role: "it",
    question: "If data was lost or deleted, do we have a usable backup of it?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q6 condition 4, Q2 permanent loss
  },
  data_left_control: {
    value: z.boolean(),
    role: "it",
    question: "Did any of the data leave our control (sent, downloaded or copied outside our systems)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q1
  },
  copies_recovered: {
    value: z.boolean(),
    role: "it",
    question: "Has every copy that left our control been recovered or destroyed, and can we prove it?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q1
  },
  availability_restored: {
    value: z.boolean(),
    role: "it",
    question: "Was the data restored in good time, with no effect on the people concerned?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q2
  },
  contract_mandate: {
    value: z.boolean(),
    role: "dpo",
    question: "Does the contract with the client authorise us to notify the authority on their behalf?",
    decisiveFor: [], // Q3: changes the processor's task, not the outcome
  },
  can_contact_individually: {
    value: z.boolean(),
    role: "business_owner",
    question: "Can we contact each person concerned directly (we have their email or address) without disproportionate effort?",
    decisiveFor: [], // Art. 34(3)(c): direct messages or public announcement
  },
  people_affected: {
    value: z.boolean(),
    role: "business_owner",
    question: "Is harm already reaching people (fraud attempts, phishing emails, complaints)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  records_exists: {
    value: z.boolean(),
    role: "it",
    question: "Do we have logs showing what was accessed or taken?",
    decisiveFor: [],
  },
  safe_channel: {
    value: z.boolean(),
    role: "it",
    question: "Do we have a communication channel the attacker cannot see?",
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
