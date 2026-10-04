// GDPR regulation module: pure evaluate(snapshot) -> Assessment.
// Asymmetry (R08, "règle anti-pire-cas"): a "required" outcome may rest on proposed facts (listed in factsToConfirm);
// a "not_required" outcome needs every fact it relies on to be confirmed, otherwise the obligation is "undetermined".
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
    blockingQuestions: blocking,
  };
}

function notRequired(facts: Facts, base: Base, cited: GdprFactKey[], reasons: string[]): Obligation {
  const open = unconfirmed(facts, cited);
  // Guard: "not required" on an unconfirmed fact is never allowed (R08). Degrade to undetermined.
  if (open.length > 0)
    return undetermined(base, cited, [...reasons, "These facts must be confirmed before concluding: " + open.join(", ") + "."], open);
  return { ...base, deadline: undefined, status: "not_required", factsToConfirm: [], reasons, citedFacts: cited, blockingQuestions: [] };
}

function undetermined(base: Base, cited: GdprFactKey[], reasons: string[], blocking: GdprFactKey[]): Obligation {
  return { ...base, status: "undetermined", factsToConfirm: [], reasons, citedFacts: cited, blockingQuestions: blocking };
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
// RULES — provisional, pending Martyna's trees.
// Each function below is one legal rule, written to be read by a lawyer.
// ===========================================================================

// Encryption alone never counts: the key must also be confirmed safe (R08, Art. 34(3)(a)).
function unintelligibleConfirmed(f: Facts): boolean {
  return confirmedIs(f, "encrypted", true) && confirmedIs(f, "keys_safe", true);
}

// The encryption exception is still reachable unless one of its two facts is confirmed false.
function encryptionExceptionStillPossible(f: Facts): GdprFactKey[] {
  if (confirmedIs(f, "encrypted", false) || confirmedIs(f, "keys_safe", false)) return [];
  return unconfirmed(f, ["encrypted", "keys_safe"]);
}

// Provisional, pending Martyna's trees.
// Applicability: GDPR applies when personal data is affected.
function applicability(f: Facts): Assessment["applicability"] {
  if (known(f, "personal_data") === true) return "applicable";
  if (confirmedIs(f, "personal_data", false)) return "not_applicable";
  // Unknown, disputed, or only *proposed* false: we never conclude "not applicable" on an unconfirmed fact.
  return "unknown";
}

// Provisional, pending Martyna's trees.
// Art. 33(5): every personal data breach is documented, whatever the risk.
function recordBreach(f: Facts): Obligation {
  return required(f, RECORD, ["personal_data"], ["Every personal data breach must be documented in the internal breach register."]);
}

// Provisional, pending Martyna's trees.
// Art. 33(2): a processor informs the controller without undue delay.
function notifyController(f: Facts): Obligation {
  const role = known(f, "processing_role");
  if (role === "processor")
    return required(
      f,
      NOTIFY_CONTROLLER,
      ["personal_data", "processing_role"],
      ["We process this data on behalf of a client (processor): the client, as controller, must be informed without undue delay."],
      unconfirmed(f, ["processing_role"]),
    );
  if (confirmedIs(f, "processing_role", "controller"))
    return notRequired(f, NOTIFY_CONTROLLER, ["processing_role"], ["We are the controller for this data: there is no controller to inform."]);
  return undetermined(
    NOTIFY_CONTROLLER,
    ["processing_role"],
    ["We do not yet know with certainty whether this is our own data or data we process for a client."],
    ["processing_role"],
  );
}

// Provisional, pending Martyna's trees.
// Art. 33(1): the controller notifies the supervisory authority within 72 hours, unless the breach is unlikely to result in a risk.
function notifyAuthority(f: Facts): Obligation {
  if (confirmedIs(f, "processing_role", "processor"))
    return notRequired(f, NOTIFY_AUTHORITY, ["processing_role"], [
      "We are confirmed processor for this data: notifying the authority is the controller's duty (unless our contract says otherwise).",
    ]);
  if (unintelligibleConfirmed(f))
    return notRequired(f, NOTIFY_AUTHORITY, ["encrypted", "keys_safe"], [
      "The data was encrypted and the key is confirmed safe: the data is unintelligible, so a risk to individuals is unlikely.",
    ]);

  const cited: GdprFactKey[] = ["personal_data"];
  const reasons = ["Personal data is affected and no exception is established: a risk to individuals is presumed."];
  if (known(f, "processing_role") !== undefined) cited.push("processing_role");
  if (known(f, "encrypted") !== undefined) cited.push("encrypted");
  if (known(f, "keys_safe") !== undefined) cited.push("keys_safe");
  if (known(f, "encrypted") === true)
    reasons.push("Encryption is declared but not confirmed together with a safe key, so it does not exempt us.");
  const blocking = [...unconfirmed(f, ["processing_role"]), ...encryptionExceptionStillPossible(f)];
  return required(f, NOTIFY_AUTHORITY, cited, reasons, blocking);
}

const HIGH_RISK_DATA = ["special_category", "financial", "id_document", "credentials"];

// Provisional, pending Martyna's trees.
// Art. 34: inform the people concerned without undue delay when the risk to them is high, unless an Art. 34(3) exception applies.
function informSubjects(f: Facts): Obligation {
  if (unintelligibleConfirmed(f))
    return notRequired(f, INFORM_SUBJECTS, ["encrypted", "keys_safe"], [
      "Art. 34(3)(a): the data was encrypted and the key is confirmed safe, so it is unintelligible to the attacker.",
    ]);
  if (confirmedIs(f, "still_exposed", false))
    return notRequired(f, INFORM_SUBJECTS, ["still_exposed"], [
      "Art. 34(3)(b): it is confirmed the data is no longer accessible to the attacker, so the high risk is no longer likely to materialise.",
    ]);

  const exceptionFacts: GdprFactKey[] = [...encryptionExceptionStillPossible(f), ...unconfirmed(f, ["still_exposed"])];
  const sensitive = includesAny(f, "data_categories", HIGH_RISK_DATA);
  const minors = includesAny(f, "subjects_categories", ["minors"]);
  if (sensitive || minors) {
    const cited: GdprFactKey[] = ["personal_data"];
    const reasons: string[] = [];
    if (sensitive) {
      cited.push("data_categories");
      reasons.push("Sensitive data is affected (health, bank, identity documents or credentials): high risk to the people concerned.");
    }
    if (minors) {
      cited.push("subjects_categories");
      reasons.push("Children are among the people concerned: high risk.");
    }
    return required(f, INFORM_SUBJECTS, cited, reasons, exceptionFacts);
  }

  const blocking: GdprFactKey[] = [];
  if (known(f, "data_categories") === undefined) blocking.push("data_categories");
  if (known(f, "subjects_categories") === undefined) blocking.push("subjects_categories");
  return undetermined(
    INFORM_SUBJECTS,
    (["personal_data", "data_categories", "subjects_categories", "encrypted", "keys_safe", "still_exposed"] as const).filter(
      (k) => known(f, k) !== undefined,
    ),
    ["No high-risk indicator is established and no exception applies: whether the risk is high is for the lawyer to decide."],
    [...blocking, ...exceptionFacts],
  );
}

// ===========================================================================

export const GDPR_MODULE_VERSION = "0.1.0-provisional";

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
    return assessment(ALL.map((b) => notRequired(f, b, ["personal_data"], ["No personal data is affected: GDPR does not apply."])));
  if (app === "unknown")
    return assessment(
      ALL.map((b) =>
        undetermined(b, [], ["We do not yet know with certainty whether personal data is affected."], ["personal_data"]),
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
