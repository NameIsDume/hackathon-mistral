// GDPR fact catalogue: one entry per fact the rules need.
// Source of truth for the wording and routing: the fact table in the lawyers' workspace (Notion, owner: Charis),
// copied in docs/legal/decisions-2026-10-04.md ("Facts"). Existing keys are stable: they are stored in incident_events.
// The extraction schema, the questions and the rules all derive from this one list.
import { z } from "zod";
import type { Question, Role } from "@/lib/domain";

type FactDef = {
  value: z.ZodType;
  role: Role; // who holds the answer
  label: string; // a few plain words, for lists and pickers (never the key)
  question: string; // plain language, shown in the Slack DM
  decisiveFor: string[]; // obligation ids whose outcome can flip on this fact
};

export const GDPR_FACTS = {
  personal_data: {
    value: z.boolean(),
    role: "it",
    label: "Personal data involved",
    question: "Did the files or systems affected contain information about real people?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects", "gdpr.record_breach"],
  },
  breach_type: {
    value: z.array(z.enum(["confidentiality", "integrity", "availability"])),
    role: "it",
    label: "What happened to the data",
    question: "Was data seen or taken, changed, or just made unavailable?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  data_categories: {
    value: z.array(z.enum(["contact", "financial", "id_document", "credentials", "special_category", "other"])),
    role: "business_owner",
    label: "Kind of information",
    question: "What kind of information was in it (contact details, bank data, health, ID)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  subjects_count: {
    value: z.int().nonnegative(),
    role: "business_owner",
    label: "Number of people",
    question: "Roughly how many people are concerned?",
    decisiveFor: [],
  },
  subjects_categories: {
    value: z.array(z.enum(["customers", "employees", "minors", "other"])),
    role: "business_owner",
    label: "Who the people are",
    question: "Who are these people (customers, staff, children)?",
    decisiveFor: ["gdpr.inform_subjects"],
  },
  encrypted: {
    value: z.boolean(),
    role: "it",
    label: "Files were encrypted",
    question: "Were the files encrypted?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  keys_safe: {
    value: z.boolean(),
    role: "it",
    label: "Password or key still safe",
    question: "Is the encryption key or password still safe (not compromised and not obtainable by the attacker)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  still_exposed: {
    value: z.boolean(),
    role: "it",
    label: "Attacker can still get in",
    question: "Is the data still accessible to the attacker?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  malicious: {
    value: z.boolean(),
    role: "it",
    label: "Deliberate attack",
    question: "Was this a deliberate attack (not a mistake)?",
    decisiveFor: [], // aggravating factor shown to the lawyer (Q5), never flips an outcome alone
  },
  measures_taken: {
    value: z.string(),
    role: "it",
    label: "What we have done so far",
    question: "What has been done so far to stop it?",
    decisiveFor: [],
  },
  processing_role: {
    value: z.enum(["controller", "processor"]),
    role: "dpo",
    label: "Our data or a client's",
    question: "Do we decide why and how this data is used, or do we only handle it on someone else's instructions (for a client)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.notify_controller", "gdpr.inform_subjects"],
  },
  cross_border: {
    value: z.boolean(),
    role: "business_owner",
    label: "People in other countries",
    question: "Do we have offices in other EEA countries (EU, Iceland, Liechtenstein, Norway), or does this substantially affect people living in them?",
    decisiveFor: [],
  },
  // --- Added from the lawyers' decisions of 2026-10-04 ---
  records_count: {
    value: z.int().nonnegative(),
    role: "business_owner",
    label: "Number of records",
    question: "Roughly how many records (rows, files, entries) are concerned? An estimate is fine for now.",
    decisiveFor: [], // content of the notification, Art. 33(3)(a); confirmed figure needed before the register entry is complete
  },
  encryption_state_of_art: {
    value: z.boolean(),
    role: "it",
    label: "Encryption was strong and switched on",
    question: "Did the encryption meet current standards, and was it switched on at the time of the incident?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q6 condition 1
  },
  encryption_covers_copies: {
    value: z.boolean(),
    role: "it",
    label: "Encryption covered the copies taken",
    question: "Did the encryption also cover the specific copies concerned (exports, backups)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q6 condition 3
  },
  backup_exists: {
    value: z.boolean(),
    role: "it",
    label: "We have a backup",
    question: "If data was lost or deleted, do we have a usable backup of it?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q6 condition 4, Q2 permanent loss
  },
  data_left_control: {
    value: z.boolean(),
    role: "it",
    label: "Data left our hands",
    question: "Did any of the data leave our control (sent, downloaded or copied outside our systems)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q1
  },
  copies_recovered: {
    value: z.boolean(),
    role: "it",
    label: "All copies recovered or deleted",
    question: "Has every copy that left our control been recovered or destroyed, and can we prove it?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q1
  },
  availability_restored: {
    value: z.boolean(),
    role: "it",
    label: "Data was restored quickly",
    question: "Was the data restored in good time, with no effect on the people concerned?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"], // Q2
  },
  contract_mandate: {
    value: z.boolean(),
    role: "dpo",
    label: "Contract lets us notify for the client",
    question: "Does the contract with the client authorise us to notify the authority on their behalf?",
    decisiveFor: [], // Q3: changes the processor's task, not the outcome
  },
  can_contact_individually: {
    value: z.boolean(),
    role: "business_owner",
    label: "We can contact each person",
    question: "Can we contact each person concerned directly (we have their email or address) without disproportionate effort?",
    decisiveFor: [], // Art. 34(3)(c): direct messages or public announcement
  },
  people_affected: {
    value: z.boolean(),
    role: "business_owner",
    label: "People already harmed",
    question: "Is harm already reaching people (fraud attempts, phishing emails, complaints)?",
    decisiveFor: ["gdpr.notify_authority", "gdpr.inform_subjects"],
  },
  records_exists: {
    value: z.boolean(),
    role: "it",
    label: "Logs of what was accessed",
    question: "Do we have logs showing what was accessed or taken?",
    decisiveFor: [],
  },
  safe_channel: {
    value: z.boolean(),
    role: "it",
    label: "A channel the attacker cannot see",
    question: "Do we have a communication channel the attacker cannot see?",
    decisiveFor: [],
  },
} satisfies Record<string, FactDef>;

export type GdprFactKey = keyof typeof GDPR_FACTS;

// Plain words for people (Martyna: never "personal_data" or "Q5" on screen).
export const factText = (key: string) => (GDPR_FACTS as Record<string, FactDef>)[key]?.label ?? key.replaceAll("_", " ");
// Multi-word keys only: one-word keys ("encrypted", "malicious") already read as words.
const KEYS = new RegExp(`\\b(${Object.keys(GDPR_FACTS).filter((k) => k.includes("_")).sort((a, b) => b.length - a.length).join("|")})\\b`, "g");
export const plainFacts = (t: string) => t.replace(KEYS, (k) => factText(k).toLowerCase());
// The rules cite their sources ("Q5:", "(para 119)", "(Art. 34)"); the person reading does not need them.
export const plainReason = (r: string) => {
  const t = plainFacts(r.replace(/^Q\d+:\s*/, "").replace(/\s*\((?:para|paras|Art\.)[^)]*\)/g, ""));
  return t.charAt(0).toUpperCase() + t.slice(1);
};

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
