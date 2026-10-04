// Synthetic incident for the dashboard demo (R04: fictional data only).
// Scenario and routing follow the lawyers' workspace (Nuvola SAS phishing).
// Events mirror what the core appends to incident_events; the assessment is
// produced by the real GDPR module, so the obligation clocks on screen are genuine.
import type { Assessment, IncidentSnapshot } from "@/lib/domain";
import { GdprModule } from "@/lib/regulations/gdpr";
import type { EventRow } from "./view";

const INCIDENT_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "22222222-2222-4222-8222-222222222222";

// Anchor the narrative to a recent "now" so the 72h clock counts down live in the
// demo. Awareness ~2h ago (≈70h left on CNIL); first signal 28 min before that,
// matching the sheet's 09:12 → 09:40 gap. Swap for fixed sheet dates if the
// scripted run needs them.
const NOW = Date.now();
const AWARENESS_MS = NOW - 2 * 3_600_000;
const FIRST_SIGNAL_MS = AWARENESS_MS - 28 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const atMin = (minFromFirstSignal: number) => iso(FIRST_SIGNAL_MS + minFromFirstSignal * 60_000);

const FIRST_SIGNAL_AT = iso(FIRST_SIGNAL_MS);
const AWARENESS_AT = iso(AWARENESS_MS);

const P = {
  reporter: { role: "reporter" as const, name: "Léa Martin" },
  it: { role: "it" as const, name: "Samuel Cohen" },
  business: { role: "business_owner" as const, name: "Nadia Ben Salah" },
  dpo: { role: "dpo" as const, name: "Claire Dubois" },
  lawyer: { role: "lawyer" as const, name: "Marc Lefèvre" },
  management: { role: "management" as const, name: "Chief executive" },
};

const confirmed = <T>(value: T) => ({
  value,
  state: "confirmed" as const,
  method: "fixture" as const,
  sources: [{ signalId: SIGNAL_ID, excerpt: "Demo data (Nuvola SAS)." }],
});

// Facts per the scenario sheet: confidentiality (exports copied) + availability
// (no usable backup, permanent loss), ~2 400 B2B contacts, unencrypted CSV,
// attacker still holds the data, controller role, subjects in FR/BE/PL.
export const mockSnapshot: IncidentSnapshot = {
  id: INCIDENT_ID,
  version: 5,
  firstSignalAt: FIRST_SIGNAL_AT,
  awarenessAt: AWARENESS_AT,
  severity: confirmed("major"),
  signalIds: [SIGNAL_ID],
  facts: {
    personal_data: confirmed(true),
    breach_type: confirmed(["confidentiality", "availability"]),
    data_categories: confirmed(["contact"]),
    subjects_count: confirmed(2400),
    subjects_categories: confirmed(["customers"]),
    encrypted: confirmed(false),
    still_exposed: confirmed(true),
    malicious: confirmed(true),
    processing_role: confirmed("controller"),
    cross_border: confirmed(true),
    measures_taken: confirmed(
      "CRM account locked at 09:55, laptop isolated from the network, the insurer's incident response firm engaged.",
    ),
  },
};

export const mockAssessment: Assessment = GdprModule.evaluate(mockSnapshot);

export const mockIncident = {
  id: INCIDENT_ID,
  title: "Phishing → CRM compromise and ransomware",
  company: "Nuvola SAS",
  brief:
    "A salesperson clicked a phishing link; fraudulent login to the CRM account (admin rights, no MFA) and download of 3 full CRM exports. The server and the backup were then encrypted (ransomware, €180k demand). ~2,400 B2B contacts in FR/BE/PL: name, work email, phone, job title, sales history. Unencrypted CSV exports, no usable backup.",
  severity: "major" as const,
  firstSignalAt: FIRST_SIGNAL_AT,
  awarenessAt: AWARENESS_AT,
};

// Legal workstreams from the scenario sheet that the GDPR engine does not model.
// Shown as informational tracks, not engine output.
export type ScenarioTrack = {
  id: string;
  label: string;
  dueAt: string | null;
  deadlineLabel?: string;
  basis: string;
  owner: string;
  note?: string;
};

export const mockScenarioTracks: ScenarioTrack[] = [
  {
    id: "insurer",
    label: "Insurer: claim notification",
    dueAt: iso(FIRST_SIGNAL_MS + 48 * 3_600_000),
    basis: "Cyber policy terms",
    owner: "Management",
    note: "Before any contact with the attacker. Facts only, no admission of liability.",
  },
  {
    id: "police",
    label: "Police complaint",
    dueAt: iso(FIRST_SIGNAL_MS + 72 * 3_600_000),
    basis: "Art. L12-10-1 French Insurance Code",
    owner: "Lawyer",
    note: "Condition for the insurer to cover the cyber loss.",
  },
  {
    id: "ransom",
    label: "Attacker's deadline (ransom)",
    dueAt: iso(FIRST_SIGNAL_MS + (72 + 2) * 3_600_000 + 18 * 60_000),
    basis: "Management decision, blocked",
    owner: "Management",
    note: "Blocked until recorded: the insurer's written consent, complaint filed, sanctions check, CNIL notification sent or scheduled.",
  },
];

export const mockEvents: EventRow[] = [
  {
    id: 1,
    at: atMin(0),
    actor: P.reporter.name,
    type: "signal",
    signalId: SIGNAL_ID,
    connectorId: "slack-demo",
    excerpt:
      "I think I clicked a phishing link. My laptop is acting weird and I can't access the CRM anymore.",
  },
  {
    id: 2,
    at: atMin(1),
    actor: "core",
    type: "classification",
    isIncident: true,
    reason: "Reported phishing with loss of CRM access: likely incident.",
    provenance: "mistral-medium-2604",
  },
  {
    id: 3,
    at: atMin(2),
    actor: "core",
    type: "extraction",
    status: "ok",
    provenance: "mistral-medium-2604",
    recordedDemo: true,
    brief: mockIncident.brief,
    factKeys: ["personal_data", "breach_type", "still_exposed", "malicious"],
  },
  {
    id: 4,
    at: atMin(3),
    actor: "core",
    type: "notification",
    to: P.it,
    kind: "brief",
    questionIds: [],
    preview:
      "Possible new incident: phishing on Léa Martin's laptop, loss of CRM access. Can you confirm the scope?",
    slack: { channel: "D-IT-01", ts: "1" },
    delivered: true,
  },
  {
    id: 5,
    at: atMin(4),
    actor: "core",
    type: "notification",
    to: P.it,
    kind: "questions",
    questionIds: ["personal_data", "breach_type", "still_exposed", "malicious", "encrypted"],
    preview:
      "Did the systems affected contain personal data? Was data seen or copied, changed, or made unavailable? Is it still accessible to the attacker? Deliberate attack? Were the files encrypted?",
    slack: { channel: "D-IT-01", ts: "2" },
    delivered: true,
  },
  {
    id: 6,
    at: atMin(25),
    actor: P.it.name,
    type: "answer",
    by: P.it,
    factKey: "personal_data",
    answer: "yes",
    via: "slack",
  },
  {
    id: 7,
    at: atMin(26),
    actor: P.it.name,
    type: "answer",
    by: P.it,
    factKey: "still_exposed",
    answer: "yes",
    via: "slack",
  },
  {
    id: 8,
    at: atMin(26.5),
    actor: P.it.name,
    type: "answer",
    by: P.it,
    factKey: "malicious",
    answer: "yes",
    via: "slack",
  },
  {
    id: 9,
    at: atMin(27),
    actor: P.it.name,
    type: "answer",
    by: P.it,
    factKey: "encrypted",
    answer: "no",
    via: "slack",
  },
  {
    id: 10,
    at: atMin(30),
    actor: "core",
    type: "notification",
    to: P.business,
    kind: "questions",
    questionIds: ["data_categories", "subjects_count", "subjects_categories", "cross_border"],
    preview:
      "What kind of data (contact, bank, health, ID)? Roughly how many people? Who are they (customers, staff, minors)? Are some outside France?",
    slack: { channel: "D-BIZ-01", ts: "3" },
    delivered: true,
  },
  {
    id: 11,
    at: atMin(40),
    actor: P.business.name,
    type: "answer",
    by: P.business,
    factKey: "subjects_count",
    answer: "yes",
    via: "web",
  },
  {
    id: 12,
    at: atMin(41),
    actor: P.business.name,
    type: "answer",
    by: P.business,
    factKey: "cross_border",
    answer: "yes",
    via: "web",
  },
  {
    id: 13,
    at: atMin(43),
    actor: "core",
    type: "notification",
    to: P.dpo,
    kind: "questions",
    questionIds: ["processing_role"],
    preview: "Is this our data (controller) or a client's (processor)?",
    slack: { channel: "D-DPO-01", ts: "4" },
    delivered: true,
  },
  {
    id: 14,
    at: atMin(46),
    actor: P.dpo.name,
    type: "answer",
    by: P.dpo,
    factKey: "processing_role",
    answer: "yes",
    via: "web",
  },
  {
    id: 15,
    at: AWARENESS_AT,
    actor: P.dpo.name,
    type: "awareness",
    by: P.dpo,
    previousAt: null,
  },
  {
    id: 16,
    at: atMin(50),
    actor: P.it.name,
    type: "severity_confirmed",
    by: P.it,
    value: "major",
    previous: "average",
  },
  {
    id: 17,
    at: atMin(52),
    actor: "core",
    type: "notification",
    to: P.dpo,
    kind: "assessment",
    questionIds: [],
    preview:
      "Likely breach: confidentiality (exports copied) + availability (permanent loss, no backup). CNIL notification required within 72 h of awareness. CNIL is the lead authority; people concerned also in BE and PL.",
    slack: { channel: "D-DPO-01", ts: "5" },
    delivered: true,
  },
  {
    id: 18,
    at: atMin(55),
    actor: "core",
    type: "notification",
    to: P.management,
    kind: "management_note",
    questionIds: [],
    preview:
      "Major incident. Notify the insurer within 48 h. Ransom decision blocked until 4 conditions are met (insurer consent, complaint, sanctions check, CNIL sent/scheduled).",
    slack: { channel: "D-MGT-01", ts: "6" },
    delivered: true,
  },
  {
    id: 19,
    at: atMin(58),
    actor: "core",
    type: "notification",
    to: P.lawyer,
    kind: "assessment",
    questionIds: [],
    preview:
      "Data held by a malicious actor, threat of publication and permanent loss: high risk to the people concerned (Art. 34 information)? Your decision is needed.",
    slack: { channel: "D-LAW-01", ts: "7" },
    delivered: false,
    error: "Slack DM not delivered (user offline), reminder scheduled.",
  },
  {
    id: 20,
    at: atMin(75),
    actor: P.dpo.name,
    type: "decision",
    stage: "recommendation",
    by: P.dpo,
    obligationId: "gdpr.notify_authority",
    choice: "notify",
    reasons:
      "Confidentiality breach (customer exports copied) and availability breach (permanent loss), ~2,400 people, deliberate attack: notify the CNIL.",
    factsVersion: 5,
    moduleVersion: mockAssessment.moduleVersion,
  },
  {
    id: 21,
    at: atMin(80),
    actor: "core",
    type: "draft",
    document: "cnil_notification",
    status: "draft",
  },
  {
    id: 22,
    at: atMin(82),
    actor: "core",
    type: "draft",
    document: "breach_register",
    status: "draft",
  },
];
