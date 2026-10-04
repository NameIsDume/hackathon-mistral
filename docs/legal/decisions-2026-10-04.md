# Legal decisions — 2026-10-04 (source of truth for the rules)

Copied from the Notion lawyers' workspace (Martyna = final say, Charis = facts, Cécile = drafts), 12:25 UTC.
EDPB = Guidelines 9/2022 on personal data breach notification. Anything here overrides the provisional rules (`0.1.0-provisional`).

## Decision trees (Martyna)

**Art. 33 — notify the supervisory authority**
1. Personal data compromised? **Unknown → treat as yes.** No (confirmed) → not a personal data breach, log as security incident.
2. Controller becomes aware (reasonable certainty, para 34) → 72 h starts.
3. Likely risk to individuals? **If in doubt, notify (para 119). Unknown → yes.** No (confirmed) → no notification, document reasons (para 125).
4. Yes/unknown → notify within 72 h or give reasons for delay; which authority: cross-border → lead SA; no EU base → each SA concerned.
5. Send further information in phases (Art. 33(4), paras 56–57).
6. Document the breach and the decision (Art. 33(5)), whatever the outcome.

**Art. 34 — inform data subjects** (runs in parallel with Art. 33)
1. Could people be seriously harmed (high risk)? **Unknown → treat as yes.** No → no need to inform (authority can still order it).
2. Was the data unreadable to others? (encrypted, key safe, backup exists — see Q6) Yes → no need to inform, keep the proof.
3. Have we since removed the risk? **Proven by action, not by promises** (see Q1). Yes → no need to inform, keep the proof.
4. Can we contact each person without disproportionate effort? No → **public announcement** instead of direct messages.
5. Yes/unknown → inform people directly, as soon as possible.
6. Document the decision and why, whatever the outcome.

**Art. 33(2) — processor informs the controller:** the image uploaded in Notion is a copy of the Art. 33 tree (asked Martyna for the right one). Use Q3/Q4 below.

## Answers to the questions

- **Q1 Art. 34(3)(b):** "attacker no longer has access" is NOT enough. Exception met only if (a) unauthorised access has ended AND (b) no data left the controller's control, or every copy was recovered or destroyed, with evidence. Data left control, or unknown → exception not met. (para 97)
- **Q2 Availability-only:** not automatically notifiable. Before classifying as availability-only, require confirmation that no one accessed or copied the data (unknown → not availability-only). Permanent loss (no usable backup) → risk presumed → notify. Temporary loss → ask "Was the data restored in good time, with no effect on individuals?" Yes → not required, document. No/unknown → notify. (paras 21–23, Annex B iii/iv)
- **Q3 Processor confirmed:** outcome label is **"Controller's duty"**, not "not required". Processor task: notify the controller without undue delay. Add question: "Does the contract authorise us to notify the authority on the controller's behalf?" If yes, prepare the notification, send only on the controller's instruction. Role is determined **per affected dataset**, not per incident. (Art. 33(1)–(2), para 48)
- **Q4 Processor and data subjects:** do NOT run the Art. 34 evaluation; display **"Controller decides"**. Processor tasks: give the controller the facts; communicate with individuals only if the contract authorises it and the controller instructs it. (para 44, Art. 28(3)(f))
- **Q5 High risk:** presume high risk if special-category data, financial data, identity documents, login credentials (para 108), or data about children/vulnerable people (para 116). Otherwise show the aggravating factors (number of people, malicious actor, data taken, permanent loss, individuals easy to identify) and send the case to the lawyer. No numerical threshold.
- **Q6 Encryption exception:** four conditions, all confirmed by IT: (1) encryption met current standards and was active at the time; (2) key not compromised and not obtainable; (3) encryption covered the specific copies breached (exports/backups); (4) where data was lost/deleted, a backup exists. Key later compromised → re-evaluate. (paras 76–80)
- **Q7 "Do not notify" when uncertain:** explicit override with written reasons whenever the result is anything other than "not required on confirmed facts" (covers "required, facts to confirm" and "undetermined"). Add option **"defer pending facts"** with a visible countdown to 72 h. Still undetermined near the deadline → propose a **phased notification** (Art. 33(4)).
- **Q8 "Notify" against "not required":** flag, don't block. Authority: light flag + short reason. Individuals: stronger flag + mandatory reasons.
- **Q9 Who signs:** **the DPO recommends; the decision is signed by the lawyer** (or someone acting for the controller). Two separate roles in the record: "DPO recommendation" and "Decision". One person may hold both in a small organisation, but the record keeps them apart. Later: notify authority = lawyer decides with DPO recommendation; inform individuals / public communication / any override = lawyer + management.
- **Q10 Reasons:** replace the 20-character minimum with structured fields: facts relied on; risk factors considered; exception relied on, with evidence (when not notifying/informing); reasons for delay (when late); plus free text. All mandatory for "do not notify" and overrides. For "notify", facts + risk factors suffice.
- **Q11 Unknown severity:** standard (average) wave; if still unknown after a configurable period (e.g. 12 h), escalate to the full wave including management.
- **Q12 Reporter:** no message about the outcome, whatever the result. Optional configurable "report received" confirmation without assessment. If IT needs the reporter to act, that is a containment instruction sent by IT.
- **Q13 "I don't know":** **keep the AI value**, status "proposed by AI, not confirmed", together with who answered "don't know" and when. The rules engine treats the fact as unknown. If used in a notification, label it an estimate. The question is not asked again.
- **Q14 Lawyer's DM:** must contain a case summary with each fact marked confirmed / proposed / unknown; open questions; the DPO's recommendation; deadlines (72 h authority; "without undue delay" individuals); actions **"Decide"**, **"Ask a follow-up question"**, **"Request more facts"**. Sent for every decision requiring the lawyer: Art. 33, Art. 34 and overrides.

## Facts (Charis, validated)

Existing facts keep their keys; questions reworded in Notion (personal_data: "…information about real people?"; processing_role: "Do we decide why and how this data is used, or do we only handle it on someone else's instructions…?"; cross_border: "Do we have offices in other EU countries, or does this substantially affect people living in other EU countries?"). New rows: `records_exists` (logs exist showing what was accessed or taken — IT), `people_affected` (harm already reaching people: fraud attempts, phishing, complaints — business owner; harm happening = high risk, urgent Art. 34), `safe_channel` (a channel the attacker cannot see — IT). From the answers above: `records_count` (Cécile, decisive for Art. 33(3)(a); approximation accepted at first notification), encryption conditions (Q6), data left control / copies recovered (Q1), availability restored in good time (Q2), contract authorises notifying on the controller's behalf (Q3), can contact each person (Art. 34 tree).

## Test scenarios (expected results)

| Scenario | Notify CNIL | Inform subjects | Register |
|---|---|---|---|
| Demo: Nuvola phishing | required | lawyer decides | required |
| High risk: health or bank data, unencrypted | required | required | required |
| Low risk: e-mail to wrong internal colleague, deleted | not required | not required | required |
| Encrypted laptop lost, keys safe | not required | not required | required |
| Encrypted, password on a sticky note in the bag | required | required (precautionary) | required |
| Nuvola as processor for a client's data | required **by the client**; Nuvola notifies the client immediately (Art. 33(2)) | client decides | required in the client's register; Nuvola keeps its own incident log |
| No breach: phishing click, nothing accessed | not required | not required | not required, log as incident |

## Drafts (Cécile, validated)

- **CNIL labels (GDPR wording):** "(a) Nature of the breach, and categories and approximate number of data subjects and of personal data records concerned"; "(b) Name and contact details of the DPO or other contact point"; "(c) Likely consequences of the breach"; "(d) Measures taken or proposed, including mitigation"; separate field "Reasons for notifying more than 72 hours after becoming aware" (Art. 33(1)) — if within 72 h: "Not applicable, notified within 72 hours of awareness".
- **Language:** English for internal review; a French version is required before transmission (later).
- **DPO contact:** configuration data set once, auto-filled; never asked in Slack.
- **records_count:** a Slack-asked fact; approximation accepted first; confirmed figure required before the register entry is complete (phased, Art. 33(4)).
- **Likely consequences / measures:** AI drafts a first pass; **not "ready to send" until the lawyer actively signs off**; keep both the AI draft and the lawyer's final version in the audit trail. Measures: never describe a proposed measure as taken.
- **Register:** four labelled parts (Facts / Effects / Remedial action / Decision and reasons); effects and remedial action share the lawyer-approved wording with the CNIL draft; AI may phrase but never originate a non-notification justification; undetermined branch reads "Undetermined, [fact] unconfirmed"; completion marker ("3 of 4 sections complete"); **"sent" status with timestamp (and CNIL reference when available) built now**; "decision to notify" ≠ "notification sent"; an entry still "transmission not recorded" after the 72 h deadline is **automatically flagged overdue**.
- **Notice to data subjects:** generated only after the lawyer confirmed the Art. 34(1) decision; sections What happened / What this means for you (lawyer-approved likely consequences, verbatim) / What we are doing (lawyer-approved measures, verbatim) / Who to contact (dpo_contact).

## Out of scope for the hackathon (noted, not built)

Insurer notification (48 h), police complaint, ransom-payment gating, French translation, per-dataset role split beyond the controller/processor question, automatic escalation timer of Q11 (cron).
