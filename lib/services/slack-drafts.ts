// Slack actions on the drafts (#49), dispatched from slack-actions.ts for every action_id / callback_id prefixed `draft_`.
// "Approve section" (lawyer): modal pre-filled with the AI first pass, the lawyer edits and approves -> section_approved.
// "Mark as sent" (DPO): modal for the sending time and the CNIL reference -> sent. Roles are checked on submit via `people`.
import { z } from "zod";
import { DraftSection, type IncidentSnapshot, type Role } from "@/lib/domain";
import { db, listEvents, loadSnapshot, VersionConflict } from "@/lib/adapters/supabase";
import { button, context, header, markdownBlocks, openView, plain, postDm, section, type Block } from "@/lib/adapters/slack";
import { approveSection, DraftRefused, markSent, type DraftDocument } from "@/lib/services/drafts";
import { evaluate } from "@/lib/regulations/gdpr";
import { breachRegister, cnilNotification, draftState, subjectsNotice, toMarkdown, type EventRow, type GdprDocument } from "@/lib/regulations/gdpr/templates";
import { deadline } from "@/lib/clocks";
import type { Outcome } from "@/lib/services/slack-actions";

const SECTION_TITLE: Record<DraftSection, string> = { consequences: "Likely consequences", measures: "Measures" };

// A posted draft (#57): header, status line, short excerpt with "View full draft", then the draft buttons.
// The CNIL description of the breach (AI, not stored) rides in the button value so the full view shows the same text.
export function draftMessage(incidentId: string, document: DraftDocument, doc: GdprDocument, snapshot: IncidentSnapshot, events: EventRow[], now = new Date()): Block[] {
  const state = draftState(events);
  const nature = doc.sections.find((s) => s.narrative)?.narrative;
  const excerpt = nature ?? doc.sections[0]?.fields.slice(0, 3).map((f) => `*${f.label}:* ${f.value}`).join("\n") ?? "";
  const cnil = document === "cnil_notification";
  const status = cnil && state.sent ? "sent" : cnil && state.readyToSend ? "ready to send" : "draft";
  const authority = evaluate(snapshot).obligations.find((o) => o.id === "gdpr.notify_authority")?.deadline;
  const clock = cnil && !state.sent && authority && deadline(authority, snapshot, now);
  const value = JSON.stringify({ incidentId, document, ...(cnil && nature && { nature: nature.slice(0, 1400) }) });
  return [
    header(doc.title),
    context(`Status: *${status}*`, clock && clock.dueAt && clock.overdue && "*72 h deadline passed*", "To review before any use"),
    { ...section(excerpt.length > 300 ? `${excerpt.slice(0, 299)}…` : excerpt || "_No excerpt._"), accessory: button("View full draft", "draft_view", value) },
    ...draftActionBlocks(incidentId, document),
  ];
}
const ViewRef = z.object({ incidentId: z.uuid(), document: z.enum(["cnil_notification", "breach_register", "subjects_notice"]), nature: z.string().optional() });

// Buttons under the CNIL draft in the DM where drafts are posted.
export function draftActionBlocks(incidentId: string, document: DraftDocument): Block[] {
  if (document !== "cnil_notification") return [];
  const v = (section?: DraftSection) => JSON.stringify({ incidentId, ...(section && { section }) });
  return [
    {
      type: "actions",
      elements: [
        button("Approve section: likely consequences", "draft_approve_section:consequences", v("consequences"), "primary"),
        button("Approve section: measures", "draft_approve_section:measures", v("measures"), "primary"),
        button("Mark as sent", "draft_mark_sent", v()),
      ],
    },
  ];
}

const Action = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  trigger_id: z.string(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string() })).min(1),
  container: z.object({ channel_id: z.string() }),
});
const Submit = z.object({
  type: z.literal("view_submission"),
  user: z.object({ id: z.string() }),
  view: z.object({
    id: z.string(),
    callback_id: z.string(),
    private_metadata: z.string(),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.object({ value: z.string().nullish(), selected_date_time: z.number().nullish() }))) }),
  }),
});
const SectionRef = z.object({ incidentId: z.uuid(), section: DraftSection, channel: z.string() });
const SentRef = z.object({ incidentId: z.uuid(), channel: z.string() });

export function isDraftInteraction(payload: unknown): boolean {
  const p = payload as { actions?: { action_id?: unknown }[]; view?: { callback_id?: unknown } } | null;
  const id = p?.actions?.[0]?.action_id ?? p?.view?.callback_id;
  return typeof id === "string" && id.startsWith("draft_");
}

type By = { role: Role; name: string; slackUserId: string };
async function personWithRole(slackUserId: string, role: Role): Promise<By | null> {
  const { data, error } = await db().from("people").select("name, role, slack_user_id").eq("slack_user_id", slackUserId).eq("role", role).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { role, name: (data as { name: string }).name, slackUserId } : null;
}

export async function handleDraftInteraction(payload: unknown): Promise<Outcome> {
  const p = z.discriminatedUnion("type", [Action, Submit]).parse(payload);
  return p.type === "block_actions" ? onAction(p) : onSubmit(p);
}

// views.open needs the trigger_id within 3 s: only a database read before it.
async function onAction(p: z.infer<typeof Action>): Promise<Outcome> {
  const a = p.actions[0];
  const channel = p.container.channel_id;
  // Read-only: the draft as it stands now (approved sections included), for the DPO and the lawyer it was posted to.
  if (a.action_id === "draft_view") {
    const ref = ViewRef.parse(JSON.parse(a.value));
    const [people, snapshot, events] = await Promise.all([
      db().from("people").select("role").eq("slack_user_id", p.user.id).in("role", ["dpo", "lawyer"]),
      loadSnapshot(ref.incidentId),
      listEvents(ref.incidentId),
    ]);
    if (people.error) throw new Error(people.error.message);
    const allowed = !!(people.data as unknown[]).length;
    const assessment = evaluate(snapshot);
    const doc = !allowed
      ? null
      : ref.document === "cnil_notification"
        ? cnilNotification(snapshot, assessment, events, { nature: ref.nature })
        : ref.document === "breach_register"
          ? breachRegister(snapshot, assessment, events)
          : subjectsNotice(snapshot, events);
    await openView(p.trigger_id, {
      type: "modal",
      title: plain("Draft", 24),
      close: plain("Close", 24),
      blocks: doc ? markdownBlocks(toMarkdown(doc), 100) : [section(allowed ? "_No draft yet._" : "_This draft is addressed to the DPO and the lawyer._")],
    });
    return {};
  }
  if (a.action_id.startsWith("draft_approve_section:")) {
    const ref = SectionRef.parse({ ...JSON.parse(a.value), channel });
    const state = draftState(await listEvents(ref.incidentId));
    const initial = state.approved[ref.section]?.text ?? state.ai[ref.section] ?? "";
    await openView(p.trigger_id, {
      type: "modal",
      callback_id: "draft_approve_section",
      private_metadata: JSON.stringify(ref),
      title: plain("Approve section", 24),
      submit: plain("Approve", 24),
      close: plain("Cancel", 24),
      blocks: [
        section(`*${SECTION_TITLE[ref.section]}*\n_AI first pass: edit it as needed. It is ready to send only once you approve it. Both versions are kept._`),
        {
          type: "input",
          block_id: "text",
          label: plain("Final text"),
          element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 3000, ...(initial && { initial_value: initial.slice(0, 3000) }) },
        },
      ],
    });
    return {};
  }
  if (a.action_id === "draft_mark_sent") {
    const ref = SentRef.parse({ ...JSON.parse(a.value), channel });
    await openView(p.trigger_id, {
      type: "modal",
      callback_id: "draft_mark_sent",
      private_metadata: JSON.stringify(ref),
      title: plain("Mark as sent", 24),
      submit: plain("Record", 24),
      close: plain("Cancel", 24),
      blocks: [
        {
          type: "input",
          block_id: "sent_at",
          label: plain("When was it sent to the CNIL?"),
          element: { type: "datetimepicker", action_id: "sent_at", initial_date_time: Math.floor(Date.now() / 1000) },
        },
        { type: "input", block_id: "reference", optional: true, label: plain("CNIL reference"), element: { type: "plain_text_input", action_id: "reference", max_length: 200 } },
      ],
    });
    return {};
  }
  throw new z.ZodError([{ code: "custom", message: `unknown action ${a.action_id}`, path: ["actions", 0, "action_id"], input: a.action_id }]);
}

async function onSubmit(p: z.infer<typeof Submit>): Promise<Outcome> {
  const values = p.view.state.values;
  const key = `slack:${p.view.id}:${p.user.id}`; // a replayed submission records once
  const errors = (block: string, message: string): Outcome => ({ body: { response_action: "errors", errors: { [block]: message } } });
  const run = async (block: string, fn: () => Promise<unknown>): Promise<Outcome | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      if (e instanceof DraftRefused) return errors(block, e.message);
      if (e instanceof VersionConflict) return errors(block, "Something changed meanwhile: please try again.");
      throw e;
    }
  };
  const confirm = (channel: string, text: string): Outcome => ({ later: async () => void (await postDm(channel, [section(text)], text)) });

  if (p.view.callback_id === "draft_approve_section") {
    const ref = SectionRef.parse(JSON.parse(p.view.private_metadata));
    const by = await personWithRole(p.user.id, "lawyer");
    if (!by) return errors("text", "Only the lawyer can approve a section: nothing was recorded.");
    const failed = await run("text", () => approveSection(ref.incidentId, ref.section, values.text?.text?.value ?? "", by, key));
    if (failed) return failed;
    const ready = draftState(await listEvents(ref.incidentId)).readyToSend;
    return confirm(ref.channel, `Section approved: ${SECTION_TITLE[ref.section]}. ${ready ? "The CNIL notification is ready to send." : "Not ready to send yet: the other section still needs your approval."}`);
  }

  if (p.view.callback_id === "draft_mark_sent") {
    const ref = SentRef.parse(JSON.parse(p.view.private_metadata));
    const by = await personWithRole(p.user.id, "dpo");
    if (!by) return errors("sent_at", "Only the DPO can record the transmission: nothing was recorded.");
    const seconds = values.sent_at?.sent_at?.selected_date_time;
    if (!seconds) return errors("sent_at", "Please give the sending time.");
    const reference = values.reference?.reference?.value ?? null;
    const failed = await run("sent_at", () => markSent(ref.incidentId, new Date(seconds * 1000).toISOString(), reference, by, key));
    if (failed) return failed;
    return confirm(ref.channel, `Notification to the CNIL recorded as sent${reference?.trim() ? ` (reference ${reference.trim()})` : ""}.`);
  }

  throw new z.ZodError([{ code: "custom", message: `unknown view ${p.view.callback_id}`, path: ["view", "callback_id"], input: p.view.callback_id }]);
}
