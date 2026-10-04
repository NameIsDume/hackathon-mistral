// Everything a person does from Slack (#39, #48): answer, confirm or dispute a fact, confirm the severity, set the awareness
// time, record the DPO recommendation, sign the lawyer decision, ask the DPO a question, request more facts. The route verifies the signature; here: role check, one traced event, feedback in Slack.
// handleInteraction runs the part Slack waits for (views.open, modal validation) and returns the rest as `later`.
import { z } from "zod";
import { Role, Severity, type Fact } from "@/lib/domain";
import { GDPR_FACTS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { evaluate } from "@/lib/regulations/gdpr";
import { db, listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { ANSWER_LABEL, context, openDm, openView, option, plain, postDm, section, sections, updateMessage, type Block } from "@/lib/adapters/slack";
import { buildDm, type DmContext, factLabel, formatLeft, isBooleanFact, notifyWave, OBLIGATION_LABEL, recordWithRetry, showValue } from "@/lib/services/notify";
import { confirmSeverity, InvalidAwareness, setAwareness } from "@/lib/services/review";
import { decide, DECIDABLE_OBLIGATIONS, decisionStatus, DecisionRefused, flagFor, needsOverride, SIGNERS, type Stage } from "@/lib/services/decide";
import { deadline, formatParis } from "@/lib/clocks";
import { buildDraft, DraftRefused, type DraftDocument } from "@/lib/services/drafts";
import { afterSeverityChange } from "@/lib/services/triggers";
import { draftMessage, handleDraftInteraction, isDraftInteraction } from "@/lib/services/slack-drafts";
import type { GdprDocument } from "@/lib/regulations/gdpr/templates";
import { handleMemoInteraction, isMemoPreview, postLawyerMemo } from "@/lib/services/memo";

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
const SignValue = z.object({ incidentId: z.uuid(), obligationId: z.enum(DECIDABLE_OBLIGATIONS), stage: z.enum(["recommendation", "decision"]) });
const CaseValue = z.object({ incidentId: z.uuid() });
const Where = { channel: z.string(), ts: z.string() };
const FactMeta = InputValue.extend(Where);
const SignMeta = SignValue.extend(Where);
const CaseMeta = CaseValue.extend(Where);
const json = (s: string | undefined) => JSON.parse(s ?? "");

export type Outcome = { body?: object; later?: () => Promise<void> };
const errors = (block: string, message: string): Outcome => ({ body: { response_action: "errors", errors: { [block]: message } } });
const WHO: Record<Stage, string> = { recommendation: "the DPO can record a recommendation", decision: "the lawyer can sign the decision" };

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
  dontKnowBy: undefined, // an answer replaces an earlier "I don't know"
  dontKnowAt: undefined,
});

// Rebuild the clicked DM (with `note` on top) and every DPO's and lawyer's latest DM from the current state.
// A DM keeps the questions it asked that nobody answered since (so facts the lawyer re-asked stay asked).
// What buildDm needs, from the current state.
async function dmContext(incidentId: string) {
  const [snapshot, events] = await Promise.all([loadSnapshot(incidentId), listEvents(incidentId)]);
  let brief: string | null = null;
  for (const { event: e } of events) if (e.type === "extraction" && e.brief) brief = e.brief;
  const ctx: DmContext = { snapshot, assessment: evaluate(snapshot), brief, now: new Date(), decisions: decisionStatus(events) };
  return { ctx, events };
}

export async function refreshDms(incidentId: string, note: string, own?: { role: Role; channel: string; ts: string }) {
  const { ctx, events } = await dmContext(incidentId);
  type Target = { role: Role; channel: string; ts: string; reask: string[] };
  const targets = new Map<string, Target>();
  const sent: Target[] = [];
  for (const { id, event: e } of events) {
    if (e.type !== "notification" || !e.slack || isMemoPreview(e.preview)) continue; // the memo is its own message (#56)
    const reask = e.questionIds
      .map((q) => q.replace(/^gdpr\./, ""))
      .filter((k) => !events.some((x) => x.id > id && x.event.type === "answer" && x.event.factKey === k));
    const t = { role: e.to.role, ...e.slack, reask };
    sent.push(t);
    if ((e.to.role === SIGNERS.recommendation || e.to.role === SIGNERS.decision) && e.kind === "assessment") targets.set(e.to.slackUserId ?? e.to.name, t);
  }
  const list = [...targets.values()];
  if (own && !list.some((t) => t.channel === own.channel && t.ts === own.ts))
    list.push(sent.find((t) => t.channel === own.channel && t.ts === own.ts) ?? { ...own, reask: [] });
  await Promise.all(
    list.map((t) => updateMessage(t.channel, t.ts, [context(note), ...(buildDm(t.role, { ...ctx, reask: t.reask })?.blocks ?? [])].slice(0, 50), note)),
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

// Plain words for the decision modal (Martyna: no technical terms for the person who signs).
const PLAIN: Record<(typeof DECIDABLE_OBLIGATIONS)[number], { question: string; yes: string; no: string }> = {
  "gdpr.notify_authority": { question: "Should we report this to the CNIL?", yes: "Yes, report it", no: "No, don't report it" },
  "gdpr.inform_subjects": { question: "Should we tell the people affected?", yes: "Yes, tell them", no: "No, don't tell them" },
  "gdpr.notify_controller": { question: "Should we tell our client?", yes: "Yes, tell the client", no: "No, don't tell the client" },
};
const PLAIN_STATUS: Record<string, string> = {
  required: "yes, this needs to be done",
  not_required: "not needed, based on confirmed facts",
  undetermined: "your call: the facts don't settle it",
  controller_duty: "this is the client's job",
  controller_decides: "the client decides",
};
const PLAIN_CHOICE: Record<string, string> = { notify: "go ahead", do_not_notify: "don't go ahead", defer: "wait for more facts" };
// The rules cite their sources ("Q5:", "(para 119)"); the person signing does not need them.
const plainReason = (r: string) => r.replace(/^Q\d+:\s*/, "").replace(/\s*\((?:para|paras|Art\.)[^)]*\)/g, "");
const shortFactState = (f: Fact<unknown> | undefined) =>
  !f || f.value === null || f.state === "disputed" ? "unknown" : f.state === "confirmed" ? "confirmed" : "suggested by the AI";

// Q9/Q10/Q7/Q8: one modal for the DPO recommendation and the lawyer decision. Every reasons field is optional for Slack:
// decide() checks what the chosen option requires and the error comes back on the field concerned.
async function decisionModal(meta: z.infer<typeof SignMeta>): Promise<Block> {
  const [snapshot, events] = await Promise.all([loadSnapshot(meta.incidentId), listEvents(meta.incidentId)]);
  const { obligations } = evaluate(snapshot);
  const o = obligations.find((x) => x.id === meta.obligationId);
  const d = obligations.find((x) => x.id === "gdpr.notify_authority")?.deadline;
  const clock = d && deadline(d, snapshot, new Date());
  const left = clock?.dueAt ? formatLeft(clock.remainingMs) : null;
  const rec = decisionStatus(events).find((x) => x.obligationId === meta.obligationId && x.stage === "recommendation");
  const flag = flagFor(o, "notify");
  const plain_ = PLAIN[meta.obligationId];
  const intro = [
    `*${plain_.question}*`,
    o && `What the app suggests: *${PLAIN_STATUS[o.status] ?? o.status.replaceAll("_", " ")}*`,
    o?.factsToConfirm.length && `Still to be confirmed: ${o.factsToConfirm.map((k) => factLabel(k).toLowerCase()).join(", ")}.`,
    o?.reasons.length && `Why: ${o.reasons.map(plainReason).join(" ")}`,
    clock?.dueAt && `CNIL deadline: ${formatParis(clock.dueAt)} (${left})`,
    meta.stage === "decision" &&
      (rec
        ? `${rec.decision.by.name} (DPO) recommends: *${PLAIN_CHOICE[rec.decision.choice] ?? rec.decision.choice}*\n> ${rec.decision.reasons.slice(0, 800).replaceAll("\n", "\n> ")}`
        : "The DPO has not given a recommendation yet."),
    flag && "_The app says this is not needed. You can still go ahead: just say why below._",
    meta.stage === "decision" ? "_Your decision and your reasons are saved in the incident file._" : "_This is your advice. The lawyer makes the final call._",
  ];
  const input = (id: string, label: string, element: Block, hint?: string, optional = true): Block => ({
    type: "input",
    block_id: id,
    optional,
    label: plain(label, 2000),
    element: { ...element, action_id: id },
    ...(hint && { hint: plain(hint, 2000) }),
  });
  const text = { type: "plain_text_input", multiline: true, max_length: 3000 };
  const blocks: Block[] = [
    section(intro.filter(Boolean).join("\n")),
    input(
      "choice",
      meta.stage === "decision" ? "Your decision" : "Your advice",
      {
        type: "radio_buttons",
        options: [option("notify", plain_.yes), option("do_not_notify", plain_.no), option("defer", `Wait for more facts${left ? ` (CNIL deadline: ${left})` : ""}`)],
      },
      undefined,
      false,
    ),
    input(
      "factsReliedOn",
      "Which facts matter most here?",
      { type: "multi_static_select", options: Object.keys(GDPR_FACTS).map((k) => option(k, `${factLabel(k)} (${shortFactState(snapshot.facts[k])})`)) },
      "Pick a few. Not needed if you wait for more facts.",
    ),
    input("riskFactors", "What could go wrong for the people affected?", text, "For example: their emails could be used for phishing. Not needed if you wait."),
    input("exceptionRelied", "If you say no: why is it safe?", { type: "plain_text_input", max_length: 500 }, "For example: the files were encrypted and the key is safe, or the risk to people is very low."),
    input("evidence", "If you say no: how do we know?", text, "For example: IT checked the encryption, or every copy was deleted."),
  ];
  if (clock?.dueAt && clock.overdue) blocks.push(input("delayReason", "Why is this later than 72 hours?", text, "The CNIL asks for the reason when a notification is late.", false));
  blocks.push(input("freeText", "Anything else, in your own words", text, "Needed if you say no, if you go against the app's suggestion, or if you wait (say which facts you are waiting for)."));
  if (needsOverride(o))
    blocks.push(input("override", "Going against the app", { type: "checkboxes", options: [option("yes", "If I say no: I choose this even though the app suggests otherwise")] }));
  const title = meta.stage === "decision" ? "Your decision" : "Your advice";
  return { type: "modal", callback_id: "sign_decision", private_metadata: JSON.stringify(meta), title: plain(title, 24), submit: plain(meta.stage === "decision" ? "Sign" : "Send", 24), close: plain("Cancel", 24), blocks };
}

// Q14: the lawyer's follow-up question to the DPO, and the lawyer's request for more facts.
function lawyerModal(callbackId: "lawyer_ask" | "lawyer_request_facts", meta: z.infer<typeof CaseMeta>): Block {
  const element =
    callbackId === "lawyer_ask"
      ? { type: "plain_text_input", multiline: true, max_length: 3000 }
      : { type: "multi_static_select", options: Object.entries(GDPR_FACTS).map(([k, d]) => option(k, `${k} (${d.role.replace("_", " ")})`)) };
  return {
    type: "modal",
    callback_id: callbackId,
    private_metadata: JSON.stringify(meta),
    title: plain(callbackId === "lawyer_ask" ? "Ask the DPO" : "Request more facts", 24),
    submit: plain(callbackId === "lawyer_ask" ? "Send" : "Ask", 24),
    close: plain("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: "value",
        label: plain(callbackId === "lawyer_ask" ? "Your question to the DPO" : "Facts to ask again to the people who hold them", 2000),
        element: { ...element, action_id: "value" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleInteraction(payload: unknown): Promise<Outcome> {
  if (isDraftInteraction(payload)) return handleDraftInteraction(payload); // draft_* actions (#49): lib/services/slack-drafts.ts
  if ((payload as { actions?: { action_id?: string }[] })?.actions?.[0]?.action_id?.startsWith("memo_")) return handleMemoInteraction(payload); // #56: lib/services/memo.ts
  const p = Interaction.parse(payload);
  return p.type === "block_actions" ? onAction(p) : onSubmit(p);
}

async function onAction(p: BlockActions): Promise<Outcome> {
  const a = p.actions[0];
  const key = `slack:${a.action_ts}:${p.user.id}`;
  const where = { channel: p.container.channel_id, ts: p.container.message_ts };
  const refused = (what: string) => tell(p, `${what} is addressed to someone else: nothing was recorded.`);

  // Q13 "I don't know": the value and its state stay (an AI proposal stays "proposed"), who and when are kept,
  // and the question is not asked again. The rules read it as unknown (lib/regulations/gdpr/index.ts).
  if (a.action_id === "answer_unknown" || a.action_id === "fact_dont_know") {
    const v = FactRef.parse(json(a.value));
    return {
      later: async () => {
        const by = await personWithRole(p.user.id, GDPR_FACTS[v.factKey as GdprFactKey].role);
        if (!by) return refused("This question");
        await recordFact(v.incidentId, v.factKey, by, key, (old) => ({ fact: { ...old, dontKnowBy: by.name, dontKnowAt: new Date().toISOString() }, answer: "unknown" }));
        await refreshDms(v.incidentId, `Answer recorded: ${ANSWER_LABEL.unknown}`, { role: by.role, ...where });
      },
    };
  }

  if (a.action_id.startsWith("answer_")) {
    const v = AnswerValue.parse(json(a.value));
    return {
      later: async () => {
        const by = await personWithRole(p.user.id, GDPR_FACTS[v.factKey as GdprFactKey].role);
        if (!by) return refused("This question");
        await recordFact(v.incidentId, v.factKey, by, key, (old) => ({
          fact: confirmed(old, v.answer === "yes", by),
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

  if (a.action_id === "fact_input" || a.action_id.startsWith("sign_decision:") || a.action_id === "lawyer_ask" || a.action_id === "lawyer_request_facts") {
    // views.open needs the trigger_id within 3 s: done now, before the ack. Roles are checked on submit.
    const view =
      a.action_id === "fact_input"
        ? factModal({ ...InputValue.parse(json(a.value)), ...where })
        : a.action_id === "lawyer_ask" || a.action_id === "lawyer_request_facts"
          ? lawyerModal(a.action_id, { ...CaseValue.parse(json(a.value)), ...where })
          : await decisionModal({ ...SignValue.parse(json(a.value)), ...where });
    await openView(z.string().parse(p.trigger_id), view);
    return {};
  }

  // "View details" (#57): read-only modal with what this role's DM summarises (facts with sources, reasons, decisions).
  if (a.action_id === "dm_details") {
    const v = z.object({ incidentId: z.uuid(), role: Role }).parse(json(a.value));
    const [by, { ctx }] = await Promise.all([personWithRole(p.user.id, v.role), dmContext(v.incidentId)]);
    if (!by) {
      await tell(p, "These details are addressed to someone else.");
      return {};
    }
    const details = buildDm(v.role, ctx)?.details ?? [];
    await openView(z.string().parse(p.trigger_id), {
      type: "modal",
      title: plain("Details", 24),
      close: plain("Close", 24),
      blocks: (details.length ? details.flatMap(sections) : [section("_Nothing more to show._")]).slice(0, 100),
    });
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

  if (p.view.callback_id === "sign_decision") return onDecisionSubmit(p);
  if (p.view.callback_id === "lawyer_ask" || p.view.callback_id === "lawyer_request_facts") return onLawyerSubmit(p);

  throw new z.ZodError([{ code: "custom", message: `unknown view ${p.view.callback_id}`, path: ["view", "callback_id"], input: p.view.callback_id }]);
}

// ---------------------------------------------------------------------------
// Recommendation, decision and the lawyer's case (#48)
// ---------------------------------------------------------------------------

// Q9: the DPO's recommendation sends the lawyer the case (Q14); the lawyer's decision (not a deferral) builds the drafts.
async function onDecisionSubmit(p: ViewSubmission): Promise<Outcome> {
  const meta = SignMeta.parse(json(p.view.private_metadata));
  const values = p.view.state.values;
  const v = (block: string) => values[block]?.[block];
  const text = (block: string) => v(block)?.value ?? undefined;
  const by = await personWithRole(p.user.id, SIGNERS[meta.stage]);
  if (!by) return errors("choice", `Only ${WHO[meta.stage]}: nothing was recorded.`);
  const choice = z.enum(["notify", "do_not_notify", "defer"]).safeParse(v("choice")?.selected_option?.value);
  if (!choice.success) return errors("choice", "Pick an option.");
  let r;
  try {
    r = await decide({
      incidentId: meta.incidentId,
      obligationId: meta.obligationId,
      stage: meta.stage,
      choice: choice.data,
      reasons: {
        factsReliedOn: v("factsReliedOn")?.selected_options?.map((o) => o.value) ?? [],
        riskFactors: text("riskFactors") ?? "",
        exceptionRelied: text("exceptionRelied"),
        evidence: text("evidence"),
        delayReason: text("delayReason"),
        freeText: text("freeText"),
      },
      by,
      overrideRecommendation: !!v("override")?.selected_options?.length,
    });
  } catch (e) {
    if (e instanceof DecisionRefused) return errors(values[e.field] ? e.field : "choice", e.message);
    if (e instanceof VersionConflict) return errors("choice", "The facts changed meanwhile: review and submit again.");
    throw e;
  }
  const result = r;
  const drafts = meta.stage === "decision" && result.event.choice !== "defer" && !result.replayed;
  return {
    later: async () => {
      if (meta.stage === "recommendation" && !result.replayed) await notifyWave(meta.incidentId, new Date(), [SIGNERS.decision]);
      if (drafts) await postDrafts(meta.incidentId, result.idempotencyKey);
      const what = meta.stage === "decision" ? "Decision signed" : "Recommendation recorded";
      const note =
        `${what}: ${OBLIGATION_LABEL[meta.obligationId]}, ${result.event.choice.replaceAll("_", " ")}` +
        (result.event.flag ? ` (${result.event.flag})` : "") +
        (result.replayed ? " (already recorded)" : drafts ? ". Drafts sent below." : meta.stage === "recommendation" ? ". Sent to the lawyer." : ".");
      await refreshDms(meta.incidentId, note, { role: by.role, channel: meta.channel, ts: meta.ts });
      if (meta.stage === "recommendation" && !result.replayed) await postLawyerMemo(meta.incidentId); // #56, never throws
    },
  };
}

// Q14: "Ask a follow-up question" DMs every DPO (recorded as a notification, actor = the lawyer);
// "Request more facts" re-asks the chosen facts to the roles that hold them (notification events, actor = the lawyer).
async function onLawyerSubmit(p: ViewSubmission): Promise<Outcome> {
  const meta = CaseMeta.parse(json(p.view.private_metadata));
  const s = p.view.state.values.value?.value;
  const by = await personWithRole(p.user.id, SIGNERS.decision);
  if (!by) return errors("value", "Only the lawyer can do this: nothing was recorded.");
  const actor = `slack:${p.user.id}`;
  const own = { role: by.role, channel: meta.channel, ts: meta.ts };

  if (p.view.callback_id === "lawyer_request_facts") {
    const keys = (s?.selected_options ?? []).map((o) => o.value).filter((k) => k in GDPR_FACTS);
    if (!keys.length) return errors("value", "Pick at least one fact.");
    const roles = [...new Set(keys.map((k) => GDPR_FACTS[k as GdprFactKey].role))];
    return {
      later: async () => {
        await notifyWave(meta.incidentId, new Date(), roles, { reask: keys, actor, key: `slack:${p.view.id}` });
        await refreshDms(meta.incidentId, `Facts requested: ${keys.join(", ")}`, own);
      },
    };
  }

  const question = s?.value?.trim();
  if (!question) return errors("value", "Write your question.");
  return {
    later: async () => {
      const { data, error } = await db().from("people").select("name, slack_user_id").eq("role", SIGNERS.recommendation);
      if (error) throw new Error(error.message);
      const msg = `*Follow-up question from ${by.name} (lawyer):*\n${question}`;
      // ponytail: a replayed submission records once (same key) but would DM twice; Slack does not replay view submissions.
      for (const dpo of data as { name: string; slack_user_id: string | null }[]) {
        let slack: { channel: string; ts: string } | null = null;
        let err: string | undefined;
        try {
          if (!dpo.slack_user_id) throw new Error("no slack_user_id for this person");
          slack = await postDm(await openDm(dpo.slack_user_id), [section(msg)], msg);
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        await recordWithRetry(meta.incidentId, (await loadSnapshot(meta.incidentId)).version, {
          actor,
          idempotencyKey: `slack:${p.view.id}:${dpo.slack_user_id ?? dpo.name}`,
          event: {
            type: "notification",
            to: { role: SIGNERS.recommendation, name: dpo.name, ...(dpo.slack_user_id && { slackUserId: dpo.slack_user_id }) },
            kind: "decision",
            questionIds: [],
            preview: msg,
            slack,
            delivered: !!slack,
            ...(err && { error: err }),
          },
        });
      }
      await refreshDms(meta.incidentId, "Question sent to the DPO", own);
    },
  };
}

// ---------------------------------------------------------------------------
// Drafts after a decision
// ---------------------------------------------------------------------------

const DRAFTS: DraftDocument[] = ["cnil_notification", "breach_register", "subjects_notice"];

// Builds both drafts (recorded as `draft` events, keys derived from the decision) and posts them to the DPO and the lawyer.
export async function postDrafts(incidentId: string, decisionKey: string) {
  const docs: { document: DraftDocument; doc: GdprDocument }[] = [];
  for (const document of DRAFTS)
    for (let attempt = 0; ; attempt++) {
      try {
        docs.push({ document, doc: (await buildDraft(incidentId, document, `${decisionKey}:draft:${document}`)).document });
        break;
      } catch (e) {
        if (e instanceof DraftRefused) break; // subjects notice before the lawyer decided to inform
        if (!(e instanceof VersionConflict) || attempt > 0) throw e;
      }
    }
  const [{ data, error }, snapshot, events] = await Promise.all([
    db().from("people").select("slack_user_id, role").in("role", ["dpo", "lawyer"]),
    loadSnapshot(incidentId),
    listEvents(incidentId),
  ]);
  if (error) throw new Error(error.message);
  for (const person of data as { slack_user_id: string | null }[]) {
    if (!person.slack_user_id) continue;
    const channel = await openDm(person.slack_user_id);
    for (const { document, doc } of docs) await postDm(channel, draftMessage(incidentId, document, doc, snapshot, events), doc.title);
  }
}
