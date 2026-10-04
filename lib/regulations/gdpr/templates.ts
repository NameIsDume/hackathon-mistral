// GDPR documents built from facts and events: CNIL notification draft (Art. 33(3)), breach register entry (Art. 33(5))
// and notice to data subjects (Art. 34). Wording validated by Cécile (docs/legal/decisions-2026-10-04.md, "Drafts").
// Pure: no I/O; `now` and the DPO contact are injected.
// Rules (R11): every value comes from a fact or an event; an unknown value is written out literally, never left blank
// or invented; a proposed (unconfirmed) fact is flagged. "Likely consequences" and "Measures" are AI first passes until
// the lawyer approves them; the register and the notice only ever reuse the lawyer-approved wording.
import { deadline, formatParis } from "@/lib/clocks";
import type { Assessment, DraftSection, IncidentEvent, IncidentSnapshot, Obligation } from "@/lib/domain";

export const MISSING = "Unknown, to be completed";
const TO_CONFIRM = " (to be confirmed)";
const AWAITING = "Awaiting the lawyer's approval";
export const ON_TIME = "Not applicable, notified within 72 hours of awareness";

// Official Art. 33(3) wording (Cécile).
export const CNIL_LABELS = {
  a: "(a) Nature of the breach, and categories and approximate number of data subjects and of personal data records concerned",
  b: "(b) Name and contact details of the DPO or other contact point",
  c: "(c) Likely consequences of the breach",
  d: "(d) Measures taken or proposed, including mitigation",
  delay: "Reasons for notifying more than 72 hours after becoming aware",
} as const;
export const REGISTER_PARTS = ["Facts", "Effects", "Remedial action", "Decision and reasons"] as const;

// proposed: the value rests on an unconfirmed fact (a register part is complete only without missing or proposed fields).
export type Field = { label: string; value: string; missing: boolean; proposed?: boolean; sourceFact?: string };
export type Section = { heading: string; fields: Field[]; narrative?: string };
export type GdprDocument = { title: string; sections: Section[] };
// Same shape as listEvents() rows.
export type EventRow = { at: string; actor: string; event: IncidentEvent };
export type Narrative = { nature?: string | null; consequences?: string | null; measures?: string | null };

const missing = (label: string, sourceFact?: string, value = MISSING): Field => ({ label, value, missing: true, sourceFact });
const given = (label: string, value: string): Field => ({ label, value, missing: false });

const show = (v: unknown): string =>
  Array.isArray(v) ? v.map(show).join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v).replaceAll("_", " ");
const approx = (v: unknown) => `approximately ${v}`;

// A fact field, read by key (a key absent from the snapshot is unknown): disputed or null is unknown; proposed is flagged.
function fact(snapshot: IncidentSnapshot, key: string, label: string, fmt: (v: unknown) => string = show, flag = TO_CONFIRM): Field {
  const f = snapshot.facts[key];
  if (!f || f.state === "disputed" || f.value === null || f.value === undefined || (Array.isArray(f.value) && !f.value.length))
    return missing(label, key);
  const proposed = f.state === "proposed";
  return { label, value: fmt(f.value) + (proposed ? flag : ""), missing: false, sourceFact: key, ...(proposed && { proposed }) };
}
// records_count (Cécile): an approximation is accepted, flagged "(estimate)" while proposed; never inferred from subjects_count.
const recordsCount = (s: IncidentSnapshot) => fact(s, "records_count", "Approximate number of personal data records", approx, " (estimate)");

// Dates are stored in UTC and shown in Paris time (R05).
const when = (iso: string) => `${formatParis(iso)} (Paris)`;
const date = (label: string, iso: string | null) => (iso ? given(label, when(iso)) : missing(label));
const obligation = (a: Assessment, id: string) => a.obligations.find((o) => o.id === id);
const recommendation = (o: Obligation | undefined) => {
  if (!o) return MISSING;
  // Cécile: an undetermined branch reads "Undetermined, [fact] unconfirmed".
  const status =
    o.status === "undetermined"
      ? `Undetermined, ${(o.blockingQuestions.length ? o.blockingQuestions : o.citedFacts).join(", ") || "facts"} unconfirmed`
      : o.status.replaceAll("_", " ");
  return `${status} (computed, ${o.legalRefs.join(", ")}): ${o.reasons.join(" ")}`;
};

// ---------------------------------------------------------------------------
// Reading events
// ---------------------------------------------------------------------------

// Decisions, single-stage (no `stage`: a decision) or split into a DPO recommendation and the lawyer's decision (#48).
type DecisionRow = {
  at: string;
  stage: string;
  by: { role: string; name: string };
  obligationId: string;
  choice: string;
  reasons: unknown;
  factsVersion?: number;
};
export function decisions(events: EventRow[], stage = "decision"): DecisionRow[] {
  return events.flatMap(({ at, event: e }) => {
    if (e.type !== "decision") return [];
    const d = { at, stage: "decision", ...(e as object) } as DecisionRow;
    return d.stage === stage ? [d] : [];
  });
}
const latestDecision = (events: EventRow[], obligationId: string) => decisions(events).findLast((d) => d.obligationId === obligationId);
const reasonsText = (r: unknown): string =>
  typeof r === "string" ? r : r && typeof r === "object" ? Object.values(r).flat().filter(Boolean).map(String).join(" ") : "";
const CHOICE_LABEL: Record<string, string> = { notify: "Notify", do_not_notify: "Do not notify", defer: "Defer pending facts" };
const describeDecision = (d: DecisionRow) =>
  `${CHOICE_LABEL[d.choice] ?? d.choice}. Reasons: ${reasonsText(d.reasons)} Decided by ${d.by.name} (${d.by.role}) on ${when(d.at)}${d.factsVersion ? `, facts version ${d.factsVersion}` : ""}.`;

type DraftEvent = Extract<IncidentEvent, { type: "draft" }>;
const drafts = (events: EventRow[]) => events.flatMap((e) => (e.event.type === "draft" ? [{ at: e.at, ...e.event }] : [])) as (DraftEvent & { at: string })[];

// Where the CNIL draft stands: latest AI first pass and lawyer-approved text per section, transmission.
export function draftState(events: EventRow[]) {
  const all = drafts(events);
  const ai: Partial<Record<DraftSection, string | null>> = all.findLast((d) => d.ai)?.ai ?? {};
  const approved: Partial<Record<DraftSection, { text: string; by: string; at: string }>> = {};
  for (const d of all)
    if (d.status === "section_approved" && d.section && d.text) approved[d.section] = { text: d.text, by: d.by?.name ?? "", at: d.at };
  const sent = all.findLast((d) => d.status === "sent" && d.document === "cnil_notification" && d.sentAt);
  return {
    ai,
    approved,
    readyToSend: !!(approved.consequences && approved.measures), // only after the lawyer actively signed off both sections
    sent: sent ? { at: sent.sentAt!, reference: sent.reference ?? null, by: sent.by?.name ?? "" } : null,
  };
}
type State = ReturnType<typeof draftState>;

const SECTION_LABEL: Record<DraftSection, string> = { consequences: "Likely consequences", measures: "Measures taken or proposed" };
// A lawyer-approved section, or (CNIL draft only) the AI first pass clearly labelled as such.
function sectionText(state: State, section: DraftSection, aiFallback?: string | null): Field {
  const ok = state.approved[section];
  if (ok) return given(`${SECTION_LABEL[section]} (approved by ${ok.by}, ${when(ok.at)})`, ok.text);
  if (aiFallback) return { label: `${SECTION_LABEL[section]} (AI draft, not approved by the lawyer)`, value: aiFallback, missing: false, proposed: true };
  return missing(SECTION_LABEL[section], undefined, AWAITING);
}
const describeSent = (sent: NonNullable<State["sent"]>) =>
  `Sent on ${when(sent.at)}${sent.reference ? `, CNIL reference ${sent.reference}` : ""}${sent.by ? `, recorded by ${sent.by}` : ""}`;

const H72 = { policy: "duration", startEvent: "awareness", hours: 72 } as const;
const clock72 = (snapshot: IncidentSnapshot, assessment: Assessment, now: Date) => {
  const c = deadline(obligation(assessment, "gdpr.notify_authority")?.deadline ?? H72, snapshot, now);
  return c.dueAt === null ? deadline(H72, snapshot, now) : c;
};

const dpo = (contact: string | undefined) => (contact?.trim() ? given("Name and contact details", contact.trim()) : missing("Name and contact details"));

// ---------------------------------------------------------------------------
// CNIL notification (Art. 33(3))
// ---------------------------------------------------------------------------

export function cnilNotification(
  snapshot: IncidentSnapshot,
  assessment: Assessment,
  events: EventRow[],
  narrative: Narrative = {},
  now = new Date(),
  dpoContact = process.env.DPO_CONTACT,
): GdprDocument {
  const state = draftState(events);
  const decision = latestDecision(events, "gdpr.notify_authority");
  const dpoRec = decisions(events, "recommendation").findLast((d) => d.obligationId === "gdpr.notify_authority");
  const clock = clock72(snapshot, assessment, now);
  const dueAt = clock.dueAt!;
  const late = Date.parse(state.sent?.at ?? now.toISOString()) > Date.parse(dueAt);
  const awaiting = (["consequences", "measures"] as const).filter((s) => !state.approved[s]).map((s) => SECTION_LABEL[s].toLowerCase());
  const status = state.sent
    ? describeSent(state.sent)
    : state.readyToSend
      ? "Ready to send: likely consequences and measures approved by the lawyer"
      : `Draft, not ready to send: awaiting the lawyer's approval of ${awaiting.join(" and ")}`;

  const sections: Section[] = [
    {
      heading: "Document status",
      fields: [
        given("Status", status),
        given("Facts version", String(snapshot.version)),
        given("Recommendation", recommendation(obligation(assessment, "gdpr.notify_authority"))),
        ...(dpoRec ? [given("DPO recommendation", describeDecision(dpoRec))] : []),
        decision ? given("Decision", describeDecision(decision)) : missing("Decision"),
      ],
    },
    {
      heading: CNIL_LABELS.a,
      fields: [
        fact(snapshot, "breach_type", "Type of breach"),
        fact(snapshot, "data_categories", "Categories of personal data concerned"),
        fact(snapshot, "subjects_categories", "Categories of data subjects"),
        fact(snapshot, "subjects_count", "Approximate number of data subjects", approx),
        recordsCount(snapshot),
        fact(snapshot, "malicious", "Deliberate attack"),
        given("First signal", when(snapshot.firstSignalAt)),
        date("Awareness of the breach", snapshot.awarenessAt),
      ],
      ...(narrative.nature ? { narrative: narrative.nature } : {}),
    },
    { heading: CNIL_LABELS.b, fields: [dpo(dpoContact)] },
    {
      heading: CNIL_LABELS.c,
      fields: [
        fact(snapshot, "encrypted", "Data encrypted"),
        fact(snapshot, "keys_safe", "Encryption key still safe"),
        fact(snapshot, "still_exposed", "Data still accessible to the attacker"),
        sectionText(state, "consequences", narrative.consequences ?? state.ai.consequences),
      ],
    },
    {
      heading: CNIL_LABELS.d,
      fields: [
        fact(snapshot, "measures_taken", "Measures already taken (reported by IT)"),
        sectionText(state, "measures", narrative.measures ?? state.ai.measures),
      ],
    },
    {
      heading: CNIL_LABELS.delay,
      fields: [
        given("72-hour deadline", when(dueAt) + (clock.provisional ? " (provisional: awareness time not set)" : "")),
        late ? missing("Reasons") : given("Reasons", ON_TIME),
      ],
    },
  ];
  return { title: "Personal data breach notification to the CNIL (Art. 33 GDPR) — DRAFT", sections };
}

// ---------------------------------------------------------------------------
// Breach register (Art. 33(5))
// ---------------------------------------------------------------------------

const DECIDABLE = ["gdpr.notify_authority", "gdpr.inform_subjects", "gdpr.notify_controller"];

export function breachRegister(snapshot: IncidentSnapshot, assessment: Assessment, events: EventRow[], now = new Date()): GdprDocument {
  const state = draftState(events);
  const all = decisions(events);
  const recs = decisions(events, "recommendation");
  const notifyDecision = latestDecision(events, "gdpr.notify_authority");
  const clock = clock72(snapshot, assessment, now);

  const parts: Section[] = [
    {
      heading: "Facts",
      fields: [
        fact(snapshot, "personal_data", "Personal data affected"),
        fact(snapshot, "breach_type", "Type of breach"),
        fact(snapshot, "data_categories", "Categories of personal data"),
        fact(snapshot, "subjects_categories", "Categories of data subjects"),
        fact(snapshot, "subjects_count", "Approximate number of data subjects", approx),
        recordsCount(snapshot), // a confirmed figure is required before the entry is complete
        fact(snapshot, "malicious", "Deliberate attack"),
        fact(snapshot, "processing_role", "Our role"),
      ],
    },
    {
      heading: "Effects",
      fields: [
        fact(snapshot, "encrypted", "Data encrypted"),
        fact(snapshot, "keys_safe", "Encryption key still safe"),
        fact(snapshot, "still_exposed", "Data still accessible to the attacker"),
        sectionText(state, "consequences"),
      ],
    },
    { heading: "Remedial action", fields: [fact(snapshot, "measures_taken", "Measures already taken (reported by IT)"), sectionText(state, "measures")] },
    {
      heading: "Decision and reasons",
      fields: [
        ...assessment.obligations.map((o) => given(`Recommendation: ${o.id}`, recommendation(o))),
        ...recs.map((d) => given(`DPO recommendation: ${d.obligationId}`, describeDecision(d))),
        ...all.filter((d) => DECIDABLE.includes(d.obligationId)).map((d) => given(`Decision: ${d.obligationId}`, describeDecision(d))),
        ...(notifyDecision ? [] : [missing("Decision: gdpr.notify_authority")]),
      ],
    },
  ];
  const complete = parts.filter((p) => p.fields.every((f) => !f.missing && !f.proposed)).length;

  // "Decision to notify" is not "notification sent"; past 72 h without a recorded transmission = overdue.
  const notNotifying = notifyDecision?.choice === "do_not_notify";
  const overdue = !state.sent && !notNotifying && "overdue" in clock && clock.overdue;
  const transmission = state.sent
    ? describeSent(state.sent)
    : notNotifying
      ? "Not notified: decision not to notify (reasons below)"
      : `${notifyDecision?.choice === "notify" ? "Decision to notify" : notifyDecision?.choice === "defer" ? "Decision deferred pending facts" : "No decision yet"}; transmission not recorded`;

  const timeline: Field[] = [given("First signal", when(snapshot.firstSignalAt))];
  for (const { at, event: e } of events) {
    if (e.type === "awareness") timeline.push(given(`${when(at)} · Awareness set`, `${when(e.at)} by ${e.by.name} (${e.by.role})`));
    if (e.type === "decision") timeline.push(given(`${when(at)} · Decision on ${e.obligationId}`, `${e.choice} by ${e.by.name} (${e.by.role})`));
    if (e.type === "draft" && e.status === "draft") timeline.push(given(`${when(at)} · Draft ${e.document}`, "generated"));
    if (e.type === "draft" && e.status === "section_approved")
      timeline.push(given(`${when(at)} · Section approved: ${e.section}`, `by ${e.by?.name ?? "unknown"} (${e.by?.role ?? "unknown"})`));
    if (e.type === "draft" && e.status === "sent")
      timeline.push(given(`${when(at)} · Notification sent`, `${when(e.sentAt ?? at)}${e.reference ? `, reference ${e.reference}` : ""}`));
  }
  if (!events.some((e) => e.event.type === "awareness")) timeline.push(date("Awareness", snapshot.awarenessAt));

  return {
    title: "Personal data breach register entry (Art. 33(5) GDPR)",
    sections: [
      {
        heading: "Entry status",
        fields: [
          given("Completion", `${complete} of ${parts.length} sections complete`),
          given("Notification to the authority", transmission),
          ...(overdue ? [given("Overdue", `Yes: transmission not recorded after the 72-hour deadline (${when(clock.dueAt!)})`)] : []),
        ],
      },
      ...parts,
      { heading: "Timeline", fields: timeline },
    ],
  };
}

// ---------------------------------------------------------------------------
// Notice to data subjects (Art. 34): only once the lawyer decided to inform them
// ---------------------------------------------------------------------------

export function subjectsNotice(snapshot: IncidentSnapshot, events: EventRow[], dpoContact = process.env.DPO_CONTACT): GdprDocument | null {
  if (latestDecision(events, "gdpr.inform_subjects")?.choice !== "notify") return null;
  const state = draftState(events);
  return {
    title: "Notice to the people concerned (Art. 34 GDPR) — DRAFT",
    sections: [
      {
        heading: "What happened",
        fields: [
          fact(snapshot, "breach_type", "Type of breach"),
          fact(snapshot, "data_categories", "Information concerned"),
          date("Date we became aware", snapshot.awarenessAt),
        ],
      },
      { heading: "What this means for you", fields: [sectionText(state, "consequences")] },
      { heading: "What we are doing", fields: [sectionText(state, "measures")] },
      { heading: "Who to contact", fields: [dpo(dpoContact)] },
    ],
  };
}

export function toMarkdown(doc: GdprDocument): string {
  const out = [`# ${doc.title}`];
  for (const s of doc.sections) {
    out.push("", `## ${s.heading}`);
    if (s.narrative) out.push("", s.narrative);
    out.push("", ...s.fields.map((f) => `- **${f.label}**: ${f.missing ? `**${f.value}**` : f.value}`));
  }
  return out.join("\n") + "\n";
}
