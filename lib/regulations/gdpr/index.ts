// GDPR regulation module: pure evaluate(snapshot) -> Assessment.
// Rules: docs/legal/decisions-2026-10-04.md — Martyna's Art. 33, Art. 34 and Art. 33(2) trees and answers Q1–Q6
// (EDPB Guidelines 9/2022 on personal data breach notification; paragraph numbers below refer to them).
// Asymmetry (R08, "règle anti-pire-cas"): a "required" outcome may rest on proposed facts (listed in factsToConfirm);
// "not_required", "controller_duty" and "controller_decides" need every fact they rely on to be confirmed,
// otherwise the obligation is "undetermined". Unknown is treated as yes ("if in doubt, notify", para 119).
import type { Assessment, IncidentSnapshot, Obligation, RegulationModule } from "@/lib/domain";
import { GDPR_QUESTIONS, GdprFactValues, type GdprFactKey } from "./facts";

type Facts = IncidentSnapshot["facts"];

// ---------------------------------------------------------------------------
// Fact reading
// ---------------------------------------------------------------------------

// A fact is known only when proposed or confirmed with a non-null value. Disputed counts as unknown.
function known(facts: Facts, key: GdprFactKey): unknown {
  const f = facts[key];
  if (!f || f.state === "disputed" || f.value === null || f.value === undefined) return undefined;
  return f.value;
}

function isConfirmed(facts: Facts, key: GdprFactKey): boolean {
  const f = facts[key];
  return !!f && f.state === "confirmed" && f.value !== null && f.value !== undefined;
}

// Known value equals `expected` AND the fact is confirmed.
function confirmedIs(facts: Facts, key: GdprFactKey, expected: unknown): boolean {
  return isConfirmed(facts, key) && known(facts, key) === expected;
}

function includesAny(facts: Facts, key: GdprFactKey, values: string[]): boolean {
  const v = known(facts, key);
  return Array.isArray(v) && v.some((x) => values.includes(x));
}

const unconfirmed = (facts: Facts, keys: GdprFactKey[]) => keys.filter((k) => !isConfirmed(facts, k));
const knownOf = (facts: Facts, keys: GdprFactKey[]) => keys.filter((k) => known(facts, k) !== undefined);

// A condition is one fact with the value an exception needs (all booleans).
type Cond = [GdprFactKey, boolean];
const holds = (f: Facts, conds: Cond[]) => conds.every(([k, v]) => confirmedIs(f, k, v));
// Facts still to confirm for the conditions to hold; none when a known value already rules them out (nothing worth asking).
function stillOpen(f: Facts, conds: Cond[]): GdprFactKey[] {
  if (conds.some(([k, v]) => known(f, k) !== undefined && known(f, k) !== v)) return [];
  return conds.filter(([k, v]) => !confirmedIs(f, k, v)).map(([k]) => k);
}

// ---------------------------------------------------------------------------
// Obligation builders: they enforce the asymmetry, the rules below cannot bypass it.
// ---------------------------------------------------------------------------

type Base = Pick<Obligation, "id" | "legalRefs" | "deadline">;

function required(facts: Facts, base: Base, cited: GdprFactKey[], reasons: string[], blocking: GdprFactKey[] = []): Obligation {
  return {
    ...base,
    status: "required",
    factsToConfirm: unconfirmed(facts, cited),
    reasons,
    citedFacts: cited,
    blockingQuestions: [...new Set(blocking)],
  };
}

// "Not required" or "it is the controller's" (Q3/Q4): both lift our duty, so both need confirmed facts only.
function notRequired(
  facts: Facts,
  base: Base,
  cited: GdprFactKey[],
  reasons: string[],
  status: "not_required" | "controller_duty" | "controller_decides" = "not_required",
  blocking: GdprFactKey[] = [],
): Obligation {
  const open = unconfirmed(facts, cited);
  // Guard: lifting a duty on an unconfirmed fact is never allowed (R08). Degrade to undetermined.
  if (open.length > 0)
    return undetermined(base, cited, [...reasons, "These facts must be confirmed before concluding: " + open.join(", ") + "."], open);
  return { ...base, deadline: undefined, status, factsToConfirm: [], reasons, citedFacts: cited, blockingQuestions: blocking };
}

function undetermined(base: Base, cited: GdprFactKey[], reasons: string[], blocking: GdprFactKey[]): Obligation {
  return { ...base, status: "undetermined", factsToConfirm: [], reasons, citedFacts: cited, blockingQuestions: [...new Set(blocking)] };
}

const RECORD: Base = { id: "gdpr.record_breach", legalRefs: ["GDPR Art. 33(5)"] };
const NOTIFY_CONTROLLER: Base = {
  id: "gdpr.notify_controller",
  legalRefs: ["GDPR Art. 33(2)"],
  deadline: { policy: "without_undue_delay", startEvent: "awareness" },
};
const NOTIFY_AUTHORITY: Base = {
  id: "gdpr.notify_authority",
  legalRefs: ["GDPR Art. 33(1)"],
  deadline: { policy: "duration", startEvent: "awareness", hours: 72 },
};
const INFORM_SUBJECTS: Base = {
  id: "gdpr.inform_subjects",
  legalRefs: ["GDPR Art. 34"],
  deadline: { policy: "without_undue_delay", startEvent: "awareness" },
};
const ALL = [RECORD, NOTIFY_CONTROLLER, NOTIFY_AUTHORITY, INFORM_SUBJECTS];

// ===========================================================================
// RULES — version 1.0.0, Martyna's trees and answers of 2026-10-04.
// Each function below is one legal rule, written to be read by a lawyer.
// ===========================================================================

// Q3/Q4: the role is the controller's question; we only act as processor once it is confirmed.
const confirmedProcessor = (f: Facts) => confirmedIs(f, "processing_role", "processor");

// Art. 34 tree / people_affected: harm already reaching people (fraud attempts, phishing, complaints) means high risk, now.
// It overrides every exception: a proven harm contradicts "unintelligible" or "risk removed".
const harmReported = (f: Facts) => known(f, "people_affected") === true;

// --- Q6, encryption exception (paras 76–80) --------------------------------
// All four conditions confirmed by IT: (1) encryption met current standards and was active, (2) key not compromised
// and not obtainable, (3) encryption covered the specific copies breached, (4) where data was lost, a backup exists.
// Condition 4 can be skipped only once IT confirmed the breach did not include any loss of availability.
function encryptionConds(f: Facts): Cond[] {
  const conds: Cond[] = [
    ["encrypted", true],
    ["encryption_state_of_art", true],
    ["keys_safe", true],
    ["encryption_covers_copies", true],
  ];
  if (!noLossConfirmed(f)) conds.push(["backup_exists", true]);
  return conds;
}
const noLossConfirmed = (f: Facts) => isConfirmed(f, "breach_type") && !includesAny(f, "breach_type", ["availability"]);
const unintelligible = (f: Facts) => holds(f, encryptionConds(f));
const unintelligibleCited = (f: Facts): GdprFactKey[] => [
  ...encryptionConds(f).map(([k]) => k),
  ...(noLossConfirmed(f) ? (["breach_type"] as const) : []),
];

// --- Q1, risk removed by action, not by promises (para 97) -----------------
// (a) the unauthorised access has ended AND (b) no data left our control, or every copy was recovered or destroyed.
function riskRemovedConds(f: Facts): Cond[] {
  // Branch (b): "no data left" unless data is known to have left, or every copy is already confirmed recovered.
  const left = !confirmedIs(f, "data_left_control", false) && (known(f, "data_left_control") === true || confirmedIs(f, "copies_recovered", true));
  return [["still_exposed", false], left ? ["copies_recovered", true] : ["data_left_control", false]];
}
const riskRemoved = (f: Facts) => holds(f, riskRemovedConds(f));

// Art. 33 tree step 3 for a contained mistake (e-mail to the wrong colleague, deleted): risk unlikely only when it was
// not a deliberate attack AND Q1 holds. A malicious actor who had access keeps the risk alive (interpretation, see PR).
const containedMistakeConds = (f: Facts): Cond[] => [["malicious", false], ...riskRemovedConds(f)];

// --- Q2, availability-only breach (paras 21–23, Annex B) -------------------
// Availability-only requires IT to confirm nobody accessed or copied the data: breach_type confirmed as availability alone.
function availabilityOnly(f: Facts, confirmedOnly = true): boolean {
  const v = known(f, "breach_type");
  return (!confirmedOnly || isConfirmed(f, "breach_type")) && Array.isArray(v) && v.length === 1 && v[0] === "availability";
}
// Permanent loss (no usable backup): risk presumed.
const permanentLoss = (f: Facts) => includesAny(f, "breach_type", ["availability"]) && known(f, "backup_exists") === false;
// Restored in good time with no effect on individuals: no risk, document it.
const restoredConds: Cond[] = [["availability_restored", true]];
const restoredInTime = (f: Facts) => availabilityOnly(f) && !permanentLoss(f) && holds(f, restoredConds);
const restoredOpen = (f: Facts) => (availabilityOnly(f, false) && !permanentLoss(f) ? stillOpen(f, restoredConds) : []);

// Applicability, Art. 33 tree step 1: personal data compromised? Unknown → treat as yes. Only a confirmed "no" ends it.
function applicability(f: Facts): Assessment["applicability"] {
  return confirmedIs(f, "personal_data", false) ? "not_applicable" : "applicable";
}

// Art. 33(5): every personal data breach is documented, whatever the decision.
// Art. 33(2) tree: for a confirmed processor the register is the controller's; we keep our own incident log.
function recordBreach(f: Facts): Obligation {
  if (confirmedProcessor(f))
    return notRequired(
      f,
      RECORD,
      ["processing_role"],
      ["The breach is recorded in the client's register (the controller's, Art. 33(5)). Nuvola keeps its own incident log."],
      "controller_duty",
    );
  return required(
    f,
    RECORD,
    ["personal_data"],
    ["Every personal data breach must be documented in the internal breach register, with the facts, effects, remedial action and the decision."],
    unconfirmed(f, ["personal_data"]),
  );
}

// Art. 33(2) tree: a processor informs the controller without undue delay, with no risk check (para 44),
// then assists and updates it in phases as facts emerge (para 45).
function notifyController(f: Facts): Obligation {
  if (known(f, "processing_role") === "processor")
    return required(
      f,
      NOTIFY_CONTROLLER,
      ["personal_data", "processing_role"],
      [
        "We process this data on behalf of a client (processor): the client, as controller, must be informed without undue delay, whatever the risk (para 44).",
        "We then assist the client and send further information in phases as facts emerge (para 45).",
      ],
      unconfirmed(f, ["personal_data", "processing_role"]),
    );
  if (confirmedIs(f, "processing_role", "controller"))
    return notRequired(f, NOTIFY_CONTROLLER, ["processing_role"], ["We are the controller for this data: there is no controller to inform."]);
  return undetermined(
    NOTIFY_CONTROLLER,
    ["processing_role"],
    ["We do not yet know with certainty whether we decide how this data is used (controller) or handle it for a client (processor)."],
    ["processing_role"],
  );
}

// Art. 33(1), Art. 33 tree: notify the authority within 72 h unless the breach is unlikely to result in a risk.
// If in doubt, notify (para 119). "Not required" only on confirmed facts: Q6, Q2 (restored in time), or a contained mistake (Q1).
// Q3: confirmed processor → "Controller's duty"; the client notifies, or authorises us to (para 48).
function notifyAuthority(f: Facts): Obligation {
  if (confirmedProcessor(f)) {
    const mandate = known(f, "contract_mandate");
    return notRequired(
      f,
      NOTIFY_AUTHORITY,
      ["processing_role"],
      [
        "We are confirmed processor for this data: notifying the authority is the controller's duty (Art. 33(1)). The client runs the Art. 33 and 34 assessment (para 48).",
        mandate === true
          ? "The contract authorises us to notify on the client's behalf: prepare the notification, and send it only on the client's instruction."
          : mandate === false
            ? "The contract does not authorise us to notify on the client's behalf."
            : "To check: does the contract authorise us to notify the authority on the client's behalf?",
        "The role is determined per affected dataset, not per incident.",
      ],
      "controller_duty",
      unconfirmed(f, ["contract_mandate"]),
    );
  }
  const harm = harmReported(f);
  if (!harm && unintelligible(f))
    return notRequired(f, NOTIFY_AUTHORITY, unintelligibleCited(f), [
      "Q6: all four encryption conditions are confirmed (current standard and active, key safe, copies covered, backup where data was lost): the data is unintelligible, a risk is unlikely. Keep the proof.",
    ]);
  if (!harm && restoredInTime(f))
    return notRequired(f, NOTIFY_AUTHORITY, ["breach_type", "availability_restored"], [
      "Q2: availability-only breach (nobody accessed or copied the data) and the data was restored in good time with no effect on individuals: a risk is unlikely. Document the reasons (para 125).",
    ]);
  if (!harm && holds(f, containedMistakeConds(f)))
    return notRequired(f, NOTIFY_AUTHORITY, containedMistakeConds(f).map(([k]) => k), [
      "Not a deliberate attack, access has ended and no data left our control (or every copy was recovered or destroyed): a risk is unlikely. Document the reasons and keep the proof (para 125).",
    ]);

  const reasons: string[] = [];
  if (known(f, "personal_data") !== true)
    reasons.push("We do not yet know whether personal data is affected: treated as yes until confirmed otherwise.");
  if (harm) reasons.push("Harm is already reaching people: the risk to individuals is established.");
  else if (permanentLoss(f)) reasons.push("Q2: data lost with no usable backup (permanent loss): a risk is presumed.");
  else reasons.push("No exception is established on confirmed facts: if in doubt, notify (para 119).");
  if (known(f, "encrypted") === true && !unintelligible(f))
    reasons.push("Encryption is declared, but the four conditions of Q6 are not all confirmed, so it does not exempt us.");
  if (availabilityOnly(f, false) && !permanentLoss(f) && !restoredInTime(f))
    reasons.push("Q2: availability-only breach: notify unless the data was restored in good time with no effect on individuals.");

  const cited: GdprFactKey[] = [
    "personal_data",
    ...knownOf(f, ["processing_role", "breach_type", "encrypted", "keys_safe", "people_affected", "backup_exists"]),
  ];
  const blocking: GdprFactKey[] = [...unconfirmed(f, ["personal_data", "processing_role"])];
  if (!harm) blocking.push(...stillOpen(f, encryptionConds(f)), ...stillOpen(f, containedMistakeConds(f)), ...restoredOpen(f));
  if (known(f, "records_count") === undefined) blocking.push("records_count"); // content of the notice, Art. 33(3)(a)
  return required(f, NOTIFY_AUTHORITY, cited, reasons, blocking);
}

// Q5: high risk presumed for these data categories (para 108) or for children / vulnerable people (para 116).
const HIGH_RISK_DATA = ["special_category", "financial", "id_document", "credentials"];

// Q5: aggravating factors shown to the lawyer when no presumption applies. No numerical threshold.
function aggravatingFactors(f: Facts): string[] {
  const out: string[] = [];
  const n = known(f, "subjects_count");
  if (typeof n === "number") out.push(`${n} people concerned`);
  if (known(f, "malicious") === true) out.push("a deliberate attack (malicious actor)");
  if (includesAny(f, "breach_type", ["confidentiality"]) || known(f, "data_left_control") === true) out.push("data seen or taken");
  if (permanentLoss(f)) out.push("permanent loss (no usable backup)");
  return out;
}

// Art. 34 tree step 4 / Art. 34(3)(c): when people cannot each be contacted, a public announcement replaces direct messages.
function contactReasons(f: Facts): string[] {
  return confirmedIs(f, "can_contact_individually", false)
    ? ["Art. 34(3)(c): we cannot contact each person without disproportionate effort: public announcement instead of direct messages."]
    : [];
}

// Art. 34, Art. 34 tree (in parallel with Art. 33): inform the people concerned without undue delay when the risk to them is high.
// High risk: presumed per Q5 or when harm is reported; unknown data categories → treated as yes; otherwise the lawyer decides.
// Exceptions on confirmed facts only: Q6 (Art. 34(3)(a)), Q1 (Art. 34(3)(b)); and no risk at all per Q2.
// Q4: confirmed processor → "Controller decides"; we do not run the evaluation (para 44, Art. 28(3)(f)).
function informSubjects(f: Facts): Obligation {
  if (confirmedProcessor(f))
    return notRequired(
      f,
      INFORM_SUBJECTS,
      ["processing_role"],
      [
        "We are confirmed processor for this data: the client (controller) decides whether to inform the people concerned.",
        "Our task: give the client the facts. We communicate with individuals only if the contract authorises it and the client instructs it.",
      ],
      "controller_decides",
    );
  const harm = harmReported(f);
  if (!harm && unintelligible(f))
    return notRequired(f, INFORM_SUBJECTS, unintelligibleCited(f), [
      "Art. 34(3)(a), Q6: all four encryption conditions are confirmed: the data is unintelligible to anyone not authorised. Keep the proof.",
    ]);
  if (!harm && riskRemoved(f))
    return notRequired(f, INFORM_SUBJECTS, riskRemovedConds(f).map(([k]) => k), [
      "Art. 34(3)(b), Q1: access has ended and no data left our control (or every copy was recovered or destroyed), proven by action: the high risk is no longer likely to materialise. Keep the proof.",
    ]);
  if (!harm && restoredInTime(f))
    return notRequired(f, INFORM_SUBJECTS, ["breach_type", "availability_restored"], [
      "Q2: availability-only breach restored in good time with no effect on individuals: no risk, hence no high risk.",
    ]);

  const exceptionsOpen: GdprFactKey[] = harm
    ? []
    : [...stillOpen(f, encryptionConds(f)), ...stillOpen(f, riskRemovedConds(f)), ...restoredOpen(f)];
  const contactOpen: GdprFactKey[] = known(f, "can_contact_individually") === undefined ? ["can_contact_individually"] : [];
  const sensitive = includesAny(f, "data_categories", HIGH_RISK_DATA);
  const minors = includesAny(f, "subjects_categories", ["minors"]);

  if (harm || sensitive || minors) {
    const cited: GdprFactKey[] = ["personal_data"];
    const reasons: string[] = [];
    if (harm) {
      cited.push("people_affected");
      reasons.push("Harm is already reaching people (fraud attempts, phishing, complaints): high risk, inform them urgently.");
    }
    if (sensitive) {
      cited.push("data_categories");
      reasons.push("Q5: sensitive data is affected (health, bank, identity documents or credentials): high risk is presumed.");
    }
    if (minors) {
      cited.push("subjects_categories");
      reasons.push("Q5: children are among the people concerned: high risk is presumed.");
    }
    return required(f, INFORM_SUBJECTS, cited, [...reasons, ...contactReasons(f)], [...exceptionsOpen, ...contactOpen]);
  }

  if (known(f, "data_categories") === undefined)
    return required(
      f,
      INFORM_SUBJECTS,
      ["personal_data", "data_categories"],
      [
        "We do not yet know what kind of data is affected: high risk is treated as yes until confirmed otherwise (precautionary).",
        ...contactReasons(f),
      ],
      ["data_categories", ...exceptionsOpen, ...contactOpen],
    );

  const factors = aggravatingFactors(f);
  return undetermined(
    INFORM_SUBJECTS,
    knownOf(f, ["personal_data", "data_categories", "subjects_categories", "subjects_count", "malicious", "breach_type", "people_affected"]),
    [
      "Q5: no high-risk presumption applies (no sensitive data, no children, no harm reported): whether the risk is high is for the lawyer to decide.",
      factors.length ? `Aggravating factors to weigh: ${factors.join("; ")}.` : "No aggravating factor established yet.",
      ...contactReasons(f),
    ],
    [
      ...(["subjects_categories", "people_affected"] as const).filter((k) => known(f, k) === undefined),
      ...exceptionsOpen,
      ...contactOpen,
    ],
  );
}

// ===========================================================================

export const GDPR_MODULE_VERSION = "1.0.0";

export function evaluate(snapshot: IncidentSnapshot): Assessment {
  const f = snapshot.facts;
  const app = applicability(f);
  const assessment = (obligations: Obligation[]): Assessment => ({
    module: "gdpr",
    moduleVersion: GDPR_MODULE_VERSION,
    factsVersion: snapshot.version,
    applicability: app,
    obligations,
  });

  if (app === "not_applicable")
    return assessment(
      ALL.map((b) =>
        notRequired(f, b, ["personal_data"], [
          "No personal data is affected (confirmed): this is not a personal data breach. Log it as a security incident.",
        ]),
      ),
    );
  return assessment([recordBreach(f), notifyController(f), notifyAuthority(f), informSubjects(f)]);
}

export const GdprModule: RegulationModule = {
  id: "gdpr",
  version: GDPR_MODULE_VERSION,
  facts: GdprFactValues,
  questions: GDPR_QUESTIONS,
  evaluate,
};
