# Lawyers' workspace

<aside>
👋

Everything the lawyers need to decide or write during the hackathon. The developers build the code from the tables below, so **what is written here becomes the tool's behaviour**. Edit freely; ping the devs (Tim, Wael) when a table changes after H2.

</aside>

# Roles

| Who | Owns | Deliverable and deadline |
| --- | --- | --- |
| @Martyna (final say) | GDPR decision rules (Art. 33, Art. 34 and exceptions), scenario sheet, validation of every rule and draft | Scenario sheet validated at **H0** · decision trees at **H2** |
| @Charis Kaps | Fact table: plain-language questions and who answers them | Fact table complete at **H1** · question wording at **H3** |
| @Cecile vR | Draft templates: CNIL notification, breach register entry, then (after H5) notice to data subjects | Skeletons at **H5** · review of generated drafts at **H8** |

This split is a proposal. Martyna can reassign. When the three of you disagree, Martyna decides and the decision goes in the log at the bottom.

# What the tool promises

> From the first message, the tool starts the clock, asks the right people only the questions that change the GDPR analysis, and prepares the assessment and the drafts. The lawyer decides, and everything is recorded.
> 

The AI reads messages and writes text. **Written rules (yours) decide.** A human validates.

# 1. Scenario sheet (Martyna, H0)

- [ ]  Validated by Martyna

| Item | Proposed |
| --- | --- |
| Company | Nuvola SAS, B2B SaaS publisher in Lyon (fictional). 45 staff, €6m turnover. Single EU establishment. Customers in France |
| GDPR role | Controller of its sales CRM (B2B contacts). Processor for its customers' data on the production platform. Forensics confirm by 18:00 on Day 1 that the platform is on a separate network and was not reached. The system must ask this and record the answer. |
| CRM set-up | Self-hosted on Nuvola's own server. Nightly backups go to a network drive on the same network. No offline copy. |
| Thu 15 Oct, 09:12, first signal | A salesperson posts in Slack: "I think I clicked a phishing link. My laptop is acting weird and I can't access the CRM." |
| 09:40, awareness | IT confirms a fraudulent login to the salesperson's CRM account (admin rights, no multi-factor login) and the download of 3 full CRM exports. The controller now has reasonable certainty that a confidentiality breach has occurred (EDPB Guidelines 9/2022, paras 31–34). |
| 09:55 | Account locked. |
| 11:30, ransom | The CRM server and the backup drive are encrypted. A ransom note demands €180,000 in Bitcoin within 72 hours. Otherwise the data will be published on a leak site and "sent to your customers". There is no usable backup, so the loss of the data is permanent unless it can be decrypted (EDPB Annex B, example iv). |
| Facts revealed | About 2,400 contacts in FR: name, work email, phone, job title, sales history. Exports were unencrypted CSV files. |
| Cyber policy | Notify the insurer's claims hotline within 48 hours of discovery. Use the insurer's panel incident-response firm. No ransom payment, negotiation with the attacker or admission of liability without the insurer's prior written consent. |

| Track | Expected outcome | Deadline | Legal basis |
| --- | --- | --- | --- |
| Insurer | Notify immediately, before any contact with the attacker. The lawyer decides the wording, not whether to notify: facts only, no admissions on cause. | Sat 17 Oct, 09:12 (48h from first signal) | Policy conditions |
| Police complaint | File a complaint (plainte). This is a precondition for the insurer reimbursing cyber losses, including any ransom. | Sun 18 Oct, 09:12 (conservative: 72h from first knowledge of the attack) | Art. L12-10-1 Code des assurances |
| CNIL | Notify: required. Confidentiality breach (exports copied) plus permanent availability breach (no usable backup). Phased notification if facts are still missing. CNIL is lead authority; indicate that data subjects in BE and PL are affected. | Sun 18 Oct, 09:40 (72h from awareness, not extended over the weekend) | Art. 33(1), 33(3), 33(4), 56 GDPR; EDPB Guidelines 9/2022, paras 56–57, 69 |
| Data subjects | Recommend informing them; the lawyer confirms. High risk because: data held by a malicious actor, explicit threat to publish it and contact the people concerned, permanent loss, possible health and union data in the notes field. Send in FR, NL and PL with instructions on how to check the message is genuine. | Without undue delay | Art. 34(1), 34(2) GDPR; EDPB paras 91–92, 102, 114 |
| Ransom payment | A management decision, not a legal one. Blocked until four things are recorded: insurer's written consent, complaint filed, sanctions check on the attacker group, CNIL notification sent or scheduled. Paying does not remove the duty to notify CNIL or to inform data subjects. | Attacker's deadline: Sun 18 Oct, 11:30 | Art. 34(3)(b) GDPR; EU sanctions rules; policy conditions |
| Customers' data (processor role) | No notice to customers under Art. 33(2), provided forensics confirm the production platform was not reached. Re-check if forensics change. | Re-assess as facts develop | Art. 33(2) GDPR |
| Breach register | Required. Record facts, effects, remedial action and the reasons for each decision. | Ongoing, from 09:40 | Art. 33(5) GDPR; EDPB paras 121–125 |

# 2. Responsibility matrix

| Role | Responsibility |
| --- | --- |
| DPO | Assesses the breach and recommends whether to notify. Submits the CNIL form and keeps the breach register. |
| Legal | Reviews the DPO's recommendation with management and the insurer. Runs all other legal workstreams. |
| Cybersecurity | Contains the attack and establishes the facts. |
| Insurer | Confirms coverage and consents to any ransom payment. |
| Management | Decides on notifications and the ransom. |
1. Rules already agreed (please confirm)
- [ ]  **Asymmetry.** "Required" may rest on facts that are only *proposed* (shown as "required, facts to confirm"). "Not required" needs every decisive fact of that branch to be *confirmed*, otherwise the result is "undetermined". Erring towards "required" costs one unnecessary notification; erring towards "not required" is the worst case.
- [ ]  **Encryption exception, Art. 34(3)(a).** Needs both "encrypted" **and** "keys not compromised" confirmed.
- [ ]  **Disputed fact** (two sources disagree) counts as unknown. "I don't know" is an accepted answer; the question is not asked again and the branch stays undetermined.
- [ ]  **Clock.** 72 hours from **awareness**, entered by the coordinator with the real time (09:40, not the time of the click). Before that, a provisional estimate from the first signal, shown as provisional. Correcting the time never restarts the clock; the correction is recorded. Art. 34: "without undue delay", no countdown.
- [ ]  **Processor case** (Nuvola as processor for its clients' data) is a test scenario, not the demo.

# 3. Fact table (Charis, H1)

One row per fact the rules need. The tool asks **only** the questions whose answer can change the result. "Decisive for" tells the devs which rule uses it. Rows are a starting proposal: add, remove, rename.

| Fact | Definition | Who answers | Plain-language question | Decisive for |
| --- | --- | --- | --- | --- |
| personal_data | Personal data affected (Art. 4(12)) | IT | Did the files or systems affected contain information about people? | Everything (no personal data, no GDPR breach) |
| breach_type | Confidentiality / integrity / availability | IT | Was data seen or taken, changed, or just made unavailable? | Art. 33 risk |
| data_categories | Including special categories (Art. 9), financial, ID documents | Business owner | What kind of information was in it (contact details, bank data, health, ID)? | Art. 33 risk, Art. 34 high risk |
| subjects_count | Approximate number of people | Business owner | Roughly how many people are concerned? | Art. 33(3) content; risk level |
| subjects_categories | Customers, employees, minors… | Business owner | Who are these people (customers, staff, children)? | Art. 34 high risk |
| encrypted | Data unintelligible to the attacker | IT | Were the files encrypted? | Art. 34(3)(a) exception |
| keys_safe | Encryption keys not compromised | IT | Could the attacker also have the key or password? | Art. 34(3)(a) exception |
| still_exposed | Data recovered / still accessible to the attacker | IT | Is the data still out there, or did we get it back or block it? | Art. 34(3)(b) exception |
| malicious | Deliberate attack vs accident | IT | Was this an attack, or a mistake? | Risk level |
| awareness_time | Moment of reasonable certainty | Coordinator | When did we know for sure that personal data was compromised? | 72-hour clock |
| measures_taken | Containment and remediation | IT | What have we done so far to stop it? | Art. 33(3)(d) content; Art. 34(3)(b) |
| role | Controller or processor for this data | DPO | Is this our own data, or data we handle for a client? | Who notifies whom |
| cross_border | People in other EU countries | Business owner | Are some of these people outside France? | Competent authority (demo: CNIL) |
|  |  |  |  |  |

TEST NE PAS PRENDRE COMMEREEL

| Fact | Definition | Who answers | Plain-language question | Decisive for |
| --- | --- | --- | --- | --- |
| personal_data | Personal data affected (Art. 4(12)) | IT | Did the files or systems affected contain information relating to an identified or identifi-
able natural person? | Everything (no personal data, no GDPR breach) |
| breach_type | Confidentiality / integrity / availability/‘personal data breach(Art. 4(12)) | IT | Was there an accidental
or unlawful destruction, loss, alteration, unauthorised disclosure of, or
access to, personal data transmitted, stored or otherwise processed;? | Art. 33 risk |
| data_categories | Including special categories (Art. 4 (12/13/14/15), financial, ID documents | Business owner | What kind of information was in it (contact details, bank data, health, ID)? | Art. 33 risk, Art. 34 high risk |
| subjects_count | Approximate number of people | Business owner | Roughly how many people are concerned? | Art. 33(3) content; risk level |
| subjects_categories | Customers, employees, minors… | Business owner | Who are these people (customers, staff, children)? | Art. 34 high risk |
| encrypted | Data unintelligible to the attacker | IT | Were the files encrypted? | Art. 34(3)(a) exception |
| keys_safe | Encryption keys not compromised | IT | Could the attacker also have the key or password? | Art. 34(3)(a) exception |
| still_exposed | Data recovered / still accessible to the attacker | IT | Is the data still out there, or did we get it back or block it? | Art. 34(3)(b) exception |
| malicious | Deliberate attack vs accident | IT | Was this an attack, or a mistake? | Risk level |
| awareness_time | Moment of reasonable certainty | Coordinator | When did we know for sure that personal data was compromised? | 72-hour clock |
| measures_taken | Containment and remediation | IT | What have we done so far to stop it? | Art. 33(3)(d) content; Art. 34(3)(b) |
| role | Controller or processor for this data | DPO | Is this our own data, or data we handle for a client? | Who notifies whom |
| cross_border | People in other EU countries (as per art.4 (23), “‘cross-border processing’” | Business owner | Are some of these people outside France? | Competent authority (demo: CNIL) |
|  |  |  |  |  |

# 4. Decision trees (Martyna, H2)

Write each test as yes / no / unknown questions on the facts above. For every "not required" outcome, list which facts must be **confirmed**.

## Art. 33: notify the supervisory authority?

- [ ]  Tree written

## Art. 34: inform data subjects?

- [ ]  Tree written, including the three exceptions of Art. 34(3)

## Processor: inform the controller (Art. 33(2))?

- [ ]  Tree written (test scenario only)

# 5. Test scenarios (all lawyers, H1, then H8)

Each scenario = facts in, expected result out. The devs turn them into automated tests, so the rules cannot silently break after a late change.

| Scenario | Notify CNIL | Inform subjects | Register |
| --- | --- | --- | --- |
| Demo: Nuvola phishing (above) | required | lawyer decides | required |
| High risk: health or bank data, unencrypted | ? | ? | ? |
| Low risk: e-mail sent to wrong internal colleague, deleted | ? | ? | ? |
| Encrypted laptop lost, keys safe | ? | ? | ? |
| Encrypted, but password on a sticky note in the bag | ? | ? | ? |
| Nuvola as processor for a client's data | ? | ? | ? |
| No breach: phishing click, nothing accessed | ? | ? | ? |

# 6. Draft templates (Cécile, H5)

For each document: the fixed sections (your wording), which fact fills each field, and where the AI may write a narrative paragraph. Unknown values must be written as "unknown, to be completed" in the export, never left blank.

## CNIL notification (Art. 33(3))

- [ ]  Nature of the breach, categories and approximate number of people and records
- [ ]  DPO contact
- [ ]  Likely consequences
- [ ]  Measures taken or proposed
- [ ]  Reasons for any delay beyond 72 hours

## Breach register entry (Art. 33(5))

- [ ]  Facts, effects, remedial action, decision and reasons (including a decision **not** to notify)

## Notice to data subjects (Art. 34), after H5 only

- [ ]  Plain-language skeleton

# Questions from the code (for Martyna)

The provisional GDPR rules are coded (version 0.1.0-provisional). These points need a legal answer before the rules are final:

- [ ]  **Art. 34(3)(b).** Is "the attacker no longer has access" enough for this exception, given that data already copied out remains a risk?
- [ ]  **Availability-only breach.** Should a risk to individuals still be presumed (CNIL notification required) when data was only made unavailable?
- [ ]  **Processor confirmed.** Is the CNIL notification always "not required" for us, or do we need a question about the contract (mandate)?
- [ ]  **Processor and data subjects.** When we are processor, informing the people concerned is the controller's duty. Should the tool show it as "not ours" rather than evaluate it?
- [ ]  **High risk.** Should the number of people affected, or a deliberate attack, count towards high risk (Art. 34)?
- [ ]  **Encryption exception.** Is "key confirmed safe" enough, or must we also check that the encryption met the state of the art?

# Questions from the drafts (for Cécile)

The CNIL notification and the register entry are generated (provisional wording, in English). See an example on GitHub PR #31.

- [ ]  **Headings and labels:** exact wording, and should the CNIL draft be in French?
- [ ]  **DPO contact and number of records:** there is no fact for them, so they are always "Unknown, to be completed". Should they become facts asked in Slack, or be filled in by hand?
- [ ]  **Likely consequences / measures proposed:** keep them as fields the lawyer fills in, or may the AI narrative stand in for them?
- [ ]  **Register wording:** is "Decision to notify; transmission not recorded" acceptable until there is a "sent" status?

# Decision log

| When | Decision | Decided by |
| --- | --- | --- |
| 4 octobre 2026 | Demo role = controller; asymmetry rule; clock from awareness; split of work above | Tim (dev), pending Martyna's confirmation |

[Role matrix: who gets what, when (Slack DMs)](https://app.notion.com/p/Role-matrix-who-gets-what-when-Slack-DMs-3ef239041b2581b0871aee30fe0b5257?pvs=21)