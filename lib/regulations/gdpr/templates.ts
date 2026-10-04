// GDPR documents built from facts and events: CNIL notification draft (Art. 33(3)) and breach register entry (Art. 33(5)).
// PROVISIONAL WORDING: headings and labels are placeholders until Cécile (lawyer) provides the skeletons
// in the Notion lawyers' workspace. Pure: no I/O; `now` is injected for the 72-hour check.
// Rules (R11): every value comes from a fact or an event; an unknown value is written out literally, never left blank
// or invented; a proposed (unconfirmed) fact is flagged; a draft is never "sent".
import { deadline, formatParis } from "@/lib/clocks";
import type { Assessment, IncidentEvent, IncidentSnapshot, Obligation } from "@/lib/domain";
import type { GdprFactKey } from "./facts";

export const MISSING = "Unknown, to be completed";
const TO_CONFIRM = " (to be confirmed)";

export type Field = { label: string; value: string; missing: boolean; sourceFact?: string };
export type Section = { heading: string; fields: Field[]; narrative?: string };
export type GdprDocument = { title: string; sections: Section[] };
// Same shape as listEvents() rows.
export type EventRow = { at: string; actor: string; event: IncidentEvent };
export type Narrative = { nature?: string | null; consequences?: string | null };

const missing = (label: string, sourceFact?: string): Field => ({ label, value: MISSING, missing: true, sourceFact });
const given = (label: string, value: string): Field => ({ label, value, missing: false });

const show = (v: unknown): string =>
  Array.isArray(v) ? v.map(show).join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v).replaceAll("_", " ");

// A fact field: disputed or null is unknown; proposed is flagged "(to be confirmed)".
function fact(snapshot: IncidentSnapshot, key: GdprFactKey, label: string, fmt: (v: unknown) => string = show): Field {
  const f = snapshot.facts[key];
  if (!f || f.state === "disputed" || f.value === null || f.value === undefined || (Array.isArray(f.value) && !f.value.length))
    return missing(label, key);
  return { label, value: fmt(f.value) + (f.state === "proposed" ? TO_CONFIRM : ""), missing: false, sourceFact: key };
}

// Dates are stored in UTC and shown in Paris time (R05).
const when = (iso: string) => `${formatParis(iso)} (Paris)`;
const date = (label: string, iso: string | null) => (iso ? given(label, when(iso)) : missing(label));
const obligation = (a: Assessment, id: string) => a.obligations.find((o) => o.id === id);
const recommendation = (o: Obligation | undefined) =>
  o ? `${o.status.replaceAll("_", " ")} (computed, ${o.legalRefs.join(", ")}): ${o.reasons.join(" ")}` : MISSING;
const decisions = (events: EventRow[]) =>
  events.flatMap((e) => (e.event.type === "decision" ? [{ at: e.at, ...e.event }] : []));
const describeDecision = (d: ReturnType<typeof decisions>[number]) =>
  `${d.choice === "notify" ? "Notify" : "Do not notify"}. Reasons: ${d.reasons} Decided by ${d.by.name} (${d.by.role}) on ${when(d.at)}, facts version ${d.factsVersion}.`;

const H72 = { policy: "duration", startEvent: "awareness", hours: 72 } as const;

export function cnilNotification(
  snapshot: IncidentSnapshot,
  assessment: Assessment,
  events: EventRow[],
  narrative: Narrative = {},
  now = new Date(),
): GdprDocument {
  const notify = obligation(assessment, "gdpr.notify_authority");
  const decision = decisions(events).findLast((d) => d.obligationId === "gdpr.notify_authority");
  const clock = deadline(notify?.deadline ?? H72, snapshot, now);

  const sections: Section[] = [
    {
      heading: "Document status",
      fields: [
        given("Status", "Draft, not sent"),
        given("Facts version", String(snapshot.version)),
        given("Recommendation", recommendation(notify)),
        decision ? given("Decision", describeDecision(decision)) : missing("Decision"),
      ],
    },
    {
      heading: "(a) Nature of the breach",
      fields: [
        fact(snapshot, "breach_type", "Type of breach"),
        fact(snapshot, "data_categories", "Categories of personal data concerned"),
        fact(snapshot, "subjects_categories", "Categories of data subjects"),
        fact(snapshot, "subjects_count", "Approximate number of data subjects", (v) => `approximately ${v}`),
        missing("Approximate number of personal data records"),
        fact(snapshot, "malicious", "Deliberate attack"),
        given("First signal", when(snapshot.firstSignalAt)),
        date("Awareness of the breach", snapshot.awarenessAt),
      ],
      ...(narrative.nature ? { narrative: narrative.nature } : {}),
    },
    {
      heading: "(b) Data protection officer or other contact point",
      fields: [missing("Name and contact details")],
    },
    {
      heading: "(c) Likely consequences of the breach",
      fields: [
        fact(snapshot, "encrypted", "Data encrypted"),
        fact(snapshot, "keys_safe", "Encryption key still safe"),
        fact(snapshot, "still_exposed", "Data still accessible to the attacker"),
        missing("Likely consequences for the data subjects"),
      ],
      ...(narrative.consequences ? { narrative: narrative.consequences } : {}),
    },
    {
      heading: "(d) Measures taken or proposed",
      fields: [fact(snapshot, "measures_taken", "Measures taken"), missing("Measures proposed to mitigate possible adverse effects")],
    },
  ];
  if ("overdue" in clock && clock.overdue)
    sections.push({
      heading: "Reasons for the delay (Art. 33(1))",
      fields: [given("72-hour deadline", when(clock.dueAt)), missing("Reasons for notifying after 72 hours")],
    });
  return { title: "Personal data breach notification to the CNIL (Art. 33 GDPR) — DRAFT", sections };
}

export function breachRegister(snapshot: IncidentSnapshot, assessment: Assessment, events: EventRow[]): GdprDocument {
  const all = decisions(events);
  const notifyDecision = all.findLast((d) => d.obligationId === "gdpr.notify_authority");
  const timeline: Field[] = [given("First signal", when(snapshot.firstSignalAt))];
  for (const { at, event: e } of events) {
    if (e.type === "awareness") timeline.push(given(`${when(at)} · Awareness set`, `${when(e.at)} by ${e.by.name} (${e.by.role})`));
    if (e.type === "decision") timeline.push(given(`${when(at)} · Decision on ${e.obligationId}`, `${e.choice} by ${e.by.name} (${e.by.role})`));
    if (e.type === "draft") timeline.push(given(`${when(at)} · Draft ${e.document}`, e.status));
  }
  if (!events.some((e) => e.event.type === "awareness")) timeline.push(date("Awareness", snapshot.awarenessAt));

  return {
    title: "Personal data breach register entry (Art. 33(5) GDPR)",
    sections: [
      {
        heading: "Facts of the breach",
        fields: [
          fact(snapshot, "personal_data", "Personal data affected"),
          fact(snapshot, "breach_type", "Type of breach"),
          fact(snapshot, "data_categories", "Categories of personal data"),
          fact(snapshot, "subjects_categories", "Categories of data subjects"),
          fact(snapshot, "subjects_count", "Approximate number of data subjects", (v) => `approximately ${v}`),
          fact(snapshot, "malicious", "Deliberate attack"),
          fact(snapshot, "processing_role", "Our role"),
        ],
      },
      {
        heading: "Effects of the breach",
        fields: [
          fact(snapshot, "encrypted", "Data encrypted"),
          fact(snapshot, "keys_safe", "Encryption key still safe"),
          fact(snapshot, "still_exposed", "Data still accessible to the attacker"),
          missing("Likely consequences for the data subjects"),
        ],
      },
      { heading: "Remedial action", fields: [fact(snapshot, "measures_taken", "Measures taken")] },
      {
        heading: "Decisions and reasons",
        fields: [
          ...assessment.obligations.map((o) => given(`Recommendation: ${o.id}`, recommendation(o))),
          ...(all.length ? all.map((d) => given(`Decision: ${d.obligationId}`, describeDecision(d))) : [missing("Decision")]),
        ],
      },
      {
        heading: "Notification to the authority",
        fields: [
          notifyDecision
            ? given(
                "Notified",
                notifyDecision.choice === "notify"
                  ? "Decision to notify; transmission not recorded in this tool"
                  : "No: decision not to notify (reasons above)",
              )
            : missing("Notified"),
        ],
      },
      { heading: "Timeline", fields: timeline },
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
