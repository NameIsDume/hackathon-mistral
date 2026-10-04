// Everything a person does from Slack (#39): answer, confirm or dispute a fact, confirm the severity, set the awareness
// time, sign a decision. The route verifies the signature; here: role check, one traced event, feedback in Slack.
// handleInteraction runs the part Slack waits for (views.open, modal validation) and returns the rest as `later`.
import { z } from "zod";
import { Role, Severity, type Fact } from "@/lib/domain";
import { GDPR_FACTS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { evaluate } from "@/lib/regulations/gdpr";
import { db, listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { ANSWER_LABEL, markdownBlocks, openDm, openView, option, plain, postDm, section, updateMessage, type Block } from "@/lib/adapters/slack";
import { buildDm, isBooleanFact, OBLIGATION_LABEL, showValue } from "@/lib/services/notify";
import { confirmSeverity, InvalidAwareness, setAwareness } from "@/lib/services/review";
import { decide, DECIDABLE_OBLIGATIONS, decisionStatus, DecisionRefused } from "@/lib/services/decide";
import { buildDraft, type DraftDocument } from "@/lib/services/drafts";
import { afterSeverityChange } from "@/lib/services/triggers";

// ---------------------------------------------------------------------------
// Payloads (only the fields we use)
// ---------------------------------------------------------------------------

const Opt = z.object({ value: z.string() });
const BlockActions = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  trigger_id: z.string().optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        block_id: z.string().optional(),
        action_ts: z.string(),
        value: z.string().optional(),
        selected_option: Opt.nullish(),
        selected_date_time: z.number().optional(),
      }),
    )
    .min(1),
  container: z.object({ channel_id: z.string(), message_ts: z.string() }),
  response_url: z.string().optional(),
});
const ViewSubmission = z.object({
  type: z.literal("view_submission"),
  user: z.object({ id: z.string() }),
  view: z.object({
    id: z.string(),
    callback_id: z.string(),
    private_metadata: z.string(),
    state: z.object({
      values: z.record(
        z.string(),
        z.record(
          z.string(),
          z.object({ type: z.string(), value: z.string().nullish(), selected_option: Opt.nullish(), selected_options: z.array(Opt).optional() }),
        ),
      ),
    }),
  }),
});
export const Interaction = z.discriminatedUnion("type", [BlockActions, ViewSubmission]);
type BlockActions = z.infer<typeof BlockActions>;
type ViewSubmission = z.infer<typeof ViewSubmission>;

const FactKey = z.string().refine((k) => k in GDPR_FACTS);
const FactRef = z.object({ incidentId: z.uuid(), factKey: FactKey });
const AnswerValue = z.object({ incidentId: z.uuid(), factKey: z.string().refine(isBooleanFact), answer: z.enum(["yes", "no", "unknown"]) });
const InputValue = z.object({ incidentId: z.uuid(), factKey: FactKey.refine((k) => !isBooleanFact(k)) });
const SeverityValue = z.object({ incidentId: z.uuid(), severity: Severity });
const SignValue = z.object({ incidentId: z.uuid(), obligationId: z.enum(DECIDABLE_OBLIGATIONS) });
const Where = { channel: z.string(), ts: z.string() };
const FactMeta = InputValue.extend(Where);
const SignMeta = SignValue.extend(Where);
const json = (s: string | undefined) => JSON.parse(s ?? "");

export type Outcome = { body?: object; later?: () => Promise<void> };

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

type By = { role: Role; name: string; slackUserId: string };

// The clicker must be in `people` with the role the action needs.
async function personWithRole(slackUserId: string, role: Role): Promise<By | null> {
  const { data, error } = await db().from("people").select("name, role, slack_user_id").eq("slack_user_id", slackUserId).eq("role", role).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { role, name: (data as { name: string }).name, slackUserId } : null;
}

// Ephemeral reply through the interaction's response_url (only the clicker sees it, the DM is untouched).
async function tell(p: BlockActions, text: string) {
  if (p.response_url)
    await fetch(p.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
}

// One fact change + its `answer` event. Rebuilt from a fresh snapshot on each attempt (record_event replaces the whole
// facts object); one retry on a version conflict. Returns false when `change` declines (nothing to write).
// The frozen `answer` event only carries yes/no/unknown: a non-boolean value lives in the fact itself (answer "yes").
type Answer = "yes" | "no" | "unknown";
async function recordFact(
  incidentId: string,
  factKey: string,
  by: By,
  idempotencyKey: string,
  change: (old: Fact<unknown>) => { fact: Fact<unknown>; answer: Answer } | null,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const snap = await loadSnapshot(incidentId);
    const changed = change(snap.facts[factKey] ?? { value: null, state: "proposed", method: "human", sources: [] });
    if (!changed) return false;
    const { fact, answer } = changed;
    try {
      await recordEvent({
        incidentId,
        expectedVersion: snap.version,
        actor: `slack:${by.slackUserId}`,
        idempotencyKey,
        facts: { ...snap.facts, severity: snap.severity, [factKey]: fact },
        event: { type: "answer", by, factKey, answer, via: "slack" },
      });
      return true;
    } catch (e) {
      if (e instanceof VersionConflict && attempt === 0) continue;
      throw e;
    }
  }
}

const confirmed = (old: Fact<unknown>, value: unknown, by: By): Fact<unknown> => ({
  ...old,
  value,
  state: "confirmed",
  method: "human",
  confirmedBy: by.name,
  confirmedAt: new Date().toISOString(),
});

// Rebuild the clicked DM (with `note` on top) and every DPO's latest DM from the current state.
export async function refreshDms(incidentId: string, note: string, own?: { role: Role; channel: string; ts: string }) {
  const [snapshot, events] = await Promise.all([loadSnapshot(incidentId), listEvents(incidentId)]);
  let brief: string | null = null;
  for (const { event: e } of events) if (e.type === "extraction" && e.brief) brief = e.brief;
  const ctx = { snapshot, assessment: evaluate(snapshot), brief, now: new Date(), decisions: decisionStatus(events) };
  const targets = new Map<string, { role: Role; channel: string; ts: string }>();
  for (const { event: e } of events)
    if (e.type === "notification" && e.to.role === "dpo" && e.slack) targets.set(e.to.slackUserId ?? e.to.name, { role: "dpo", ...e.slack });
  const list = [...targets.values()];
  if (own && !list.some((t) => t.channel === own.channel && t.ts === own.ts)) list.push(own);
  await Promise.all(
    list.map((t) => updateMessage(t.channel, t.ts, [section(`_${note}_`), ...(buildDm(t.role, ctx)?.blocks ?? [])].slice(0, 50), note)),
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function factModal(meta: z.infer<typeof FactMeta>): Block {
  const def = GDPR_FACTS[meta.factKey as GdprFactKey].value as z.ZodType;
  const element =
    def instanceof z.ZodEnum
      ? { type: "static_select", options: def.options.map((o) => option(String(o))) }
      : def instanceof z.ZodArray
        ? { type: "multi_static_select", options: (def.element as z.ZodEnum).options.map((o) => option(String(o))) }
        : def instanceof z.ZodNumber
          ? { type: "number_input", is_decimal_allowed: false, min_value: "0" }
          : { type: "plain_text_input", multiline: true, max_length: 2000 };
  return {
    type: "modal",
    callback_id: "fact_input",
    private_metadata: JSON.stringify(meta),
    title: plain("Answer", 24),
    submit: plain("Save", 24),
    close: plain("Cancel", 24),
    blocks: [{ type: "input", block_id: "value", label: plain(GDPR_FACTS[meta.factKey as GdprFactKey].question, 2000), element: { ...element, action_id: "value" } }],
  };
}

async function decisionModal(meta: z.infer<typeof SignMeta>): Promise<Block> {
  const o = evaluate(await loadSnapshot(meta.incidentId)).obligations.find((x) => x.id === meta.obligationId);
  const firmlyRequired = o?.status === "required" && o.factsToConfirm.length === 0;
  const status = o ? `${o.status.replace("_", " ")}${o.factsToConfirm.length ? ` (facts to confirm: ${o.factsToConfirm.join(", ")})` : ""}` : "unknown";
  const blocks: Block[] = [
    section(`*${OBLIGATION_LABEL[meta.obligationId]}*\nComputed recommendation: *${status}*\n${o?.reasons.join("\n") ?? ""}\n_The recommendation never decides: you do, with written reasons (GDPR Art. 33(5))._`),
    {
      type: "input",
      block_id: "choice",
      label: plain("Decision"),
      element: { type: "radio_buttons", action_id: "choice", options: [option("notify", "Notify / inform"), option("do_not_notify", "Do not notify")] },
    },
    {
      type: "input",
      block_id: "reasons",
      label: plain("Reasons (at least 20 characters)"),
      element: { type: "plain_text_input", action_id: "reasons", multiline: true, max_length: 3000 },
    },
  ];
  if (firmlyRequired)
    blocks.push({
      type: "input",
      block_id: "override",
      optional: true,
      label: plain("Override"),
      element: { type: "checkboxes", action_id: "override", options: [option("yes", "I decide against the computed recommendation (required)")] },
    });
  return { type: "modal", callback_id: "sign_decision", private_metadata: JSON.stringify(meta), title: plain("Sign the decision", 24), submit: plain("Sign", 24), close: plain("Cancel", 24), blocks };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleInteraction(payload: unknown): Promise<Outcome> {
  const p = Interaction.parse(payload);
  return p.type === "block_actions" ? onAction(p) : onSubmit(p);
}

async function onAction(p: BlockActions): Promise<Outcome> {
  const a = p.actions[0];
  const key = `slack:${a.action_ts}:${p.user.id}`;
  const where = { channel: p.container.channel_id, ts: p.container.message_ts };
  const refused = (what: string) => tell(p, `${what} is addressed to someone else: nothing was recorded.`);

  if (a.action_id.startsWith("answer_")) {
    const v = AnswerValue.parse(json(a.value));
    return {
      later: async () => {
        const by = await personWithRole(p.user.id, GDPR_FACTS[v.factKey as GdprFactKey].role);
        if (!by) return refused("This question");
        await recordFact(v.incidentId, v.factKey, by, key, (old) => ({
          fact: confirmed(old, v.answer === "unknown" ? null : v.answer === "yes", by), // "I don't know": answered, value stays unknown
          answer: v.answer,
        }));
        await refreshDms(v.incidentId, `Answer recorded: ${ANSWER_LABEL[v.answer]}`, { role: by.role, ...where });
      },
    };
  }

  if (a.action_id === "fact_confirm" || a.action_id === "fact_wrong") {
    const v = FactRef.parse(json(a.value));
    const ok = a.action_id === "fact_confirm";
    return {
      later: async () => {
        const by = await personWithRole(p.user.id, GDPR_FACTS[v.factKey as GdprFactKey].role);
        if (!by) return refused("This question");
        let shown = "";
        // Confirm: the proposed value becomes the human-confirmed value. Wrong: disputed (counts as unknown in the
        // rules), the old value is kept for the record (answer "unknown") and the DM now asks for the right one.
        const done = await recordFact(v.incidentId, v.factKey, by, key, (old) => {
          if (old.value === null || old.state !== "proposed") return null;
          shown = showValue(old.value);
          if (!ok) return { fact: { ...old, state: "disputed", method: "human" }, answer: "unknown" };
          return { fact: confirmed(old, old.value, by), answer: typeof old.value === "boolean" && !old.value ? "no" : "yes" };
        });
        if (!done) return tell(p, "This fact is no longer a proposal: nothing was recorded.");
        await refreshDms(v.incidentId, ok ? `Confirmed: ${shown}` : `Marked wrong: ${shown}. Please give the right value below.`, { role: by.role, ...where });
      },
    };
  }

  if (a.action_id === "fact_input" || a.action_id.startsWith("sign_decision:")) {
    // views.open needs the trigger_id within 3 s: done now, before the ack. Roles are checked on submit.
    const view =
      a.action_id === "fact_input"
        ? factModal({ ...InputValue.parse(json(a.value)), ...where })
        : await decisionModal({ ...SignValue.parse(json(a.value)), ...where });
    await openView(z.string().parse(p.trigger_id), view);
    return {};
  }

  if (a.action_id === "severity") {
    const v = SeverityValue.parse(json(a.selected_option?.value));
    return {
      later: async () => {
        const by = await personWithRole(p.user.id, "dpo");
        if (!by) return refused("Confirming the severity");
        // = confirmSeverityAndNotify (lib/services/triggers.ts), with the Slack-derived key so a replayed select records once.
        const { previous } = await confirmSeverity(v.incidentId, v.severity, by, key);
        await afterSeverityChange(v.incidentId, previous, v.severity);
        await refreshDms(v.incidentId, `Severity confirmed: ${v.severity.replace("_", " ")}`, { role: "dpo", ...where });
      },
    };
  }

  if (a.action_id === "awareness") {
    const incidentId = z.uuid().parse(a.block_id?.replace(/^awareness:/, ""));
    const at = new Date(z.number().parse(a.selected_date_time) * 1000).toISOString();
    return {
      later: async () => {
        const by = await personWithRole(p.user.id, "dpo");
        if (!by) return refused("Setting the awareness time");
        try {
          await setAwareness(incidentId, at, by, key);
        } catch (e) {
          if (e instanceof InvalidAwareness) return tell(p, `Awareness time not recorded: ${e.message}.`);
          throw e;
        }
        await refreshDms(incidentId, "Awareness time recorded", { role: "dpo", ...where });
      },
    };
  }

  throw new z.ZodError([{ code: "custom", message: `unknown action ${a.action_id}`, path: ["actions", 0, "action_id"], input: a.action_id }]);
}

async function onSubmit(p: ViewSubmission): Promise<Outcome> {
  const values = p.view.state.values;
  const errors = (block: string, message: string): Outcome => ({ body: { response_action: "errors", errors: { [block]: message } } });

  if (p.view.callback_id === "fact_input") {
    const meta = FactMeta.parse(json(p.view.private_metadata));
    const s = values.value?.value;
    const raw = s?.selected_option?.value ?? s?.selected_options?.map((o) => o.value) ?? (s?.type === "number_input" ? Number(s.value) : s?.value?.trim());
    const parsed = GDPR_FACTS[meta.factKey as GdprFactKey].value.safeParse(raw);
    if (!parsed.success || (Array.isArray(raw) && !raw.length) || raw === "") return errors("value", "Please give a valid answer.");
    const by = await personWithRole(p.user.id, GDPR_FACTS[meta.factKey as GdprFactKey].role);
    if (!by) return errors("value", "This question is addressed to someone else: your answer was not recorded.");
    return {
      later: async () => {
        await recordFact(meta.incidentId, meta.factKey, by, `slack:${p.view.id}:${p.user.id}`, (old) => ({ fact: confirmed(old, parsed.data, by), answer: "yes" }));
        await refreshDms(meta.incidentId, `Answer recorded: ${showValue(parsed.data)}`, { role: by.role, channel: meta.channel, ts: meta.ts });
      },
    };
  }

  if (p.view.callback_id === "sign_decision") {
    const meta = SignMeta.parse(json(p.view.private_metadata));
    const by = await personWithRole(p.user.id, "dpo");
    if (!by) return errors("reasons", "Only the DPO can sign a decision: nothing was recorded.");
    let result;
    try {
      result = await decide({
        incidentId: meta.incidentId,
        obligationId: meta.obligationId,
        choice: z.enum(["notify", "do_not_notify"]).parse(values.choice?.choice?.selected_option?.value),
        reasons: values.reasons?.reasons?.value ?? "",
        by,
        overrideRecommendation: !!values.override?.override?.selected_options?.length,
      });
    } catch (e) {
      if (e instanceof DecisionRefused) return errors(/^Reasons/.test(e.message) ? "reasons" : values.override ? "override" : "choice", e.message);
      if (e instanceof VersionConflict) return errors("reasons", "The facts changed meanwhile: review and sign again.");
      throw e;
    }
    const r = result;
    return {
      later: async () => {
        if (!r.replayed) await postDrafts(meta.incidentId, r.idempotencyKey);
        const note = `Decision signed: ${OBLIGATION_LABEL[meta.obligationId]}, ${r.event.choice.replaceAll("_", " ")}${r.replayed ? " (already recorded)" : ". Drafts sent below."}`;
        await refreshDms(meta.incidentId, note, { role: "dpo", channel: meta.channel, ts: meta.ts });
      },
    };
  }

  throw new z.ZodError([{ code: "custom", message: `unknown view ${p.view.callback_id}`, path: ["view", "callback_id"], input: p.view.callback_id }]);
}

// ---------------------------------------------------------------------------
// Drafts after a decision
// ---------------------------------------------------------------------------

const DRAFTS: DraftDocument[] = ["cnil_notification", "breach_register"];

// Builds both drafts (recorded as `draft` events, keys derived from the decision) and posts them to the DPO and the lawyer.
export async function postDrafts(incidentId: string, decisionKey: string) {
  const docs: string[] = [];
  for (const document of DRAFTS)
    for (let attempt = 0; ; attempt++) {
      try {
        docs.push((await buildDraft(incidentId, document, `${decisionKey}:draft:${document}`)).markdown);
        break;
      } catch (e) {
        if (!(e instanceof VersionConflict) || attempt > 0) throw e;
      }
    }
  const { data, error } = await db().from("people").select("slack_user_id, role").in("role", ["dpo", "lawyer"]);
  if (error) throw new Error(error.message);
  for (const person of data as { slack_user_id: string | null }[]) {
    if (!person.slack_user_id) continue;
    const channel = await openDm(person.slack_user_id);
    for (const md of docs) await postDm(channel, [section("_Draft, to review before any use: nothing has been sent._"), ...markdownBlocks(md)].slice(0, 50), md.split("\n")[0].replace(/^# /, ""));
  }
}
