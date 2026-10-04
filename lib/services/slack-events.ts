// Conversational Slack (#55): free-text replies in the bot's DMs via the Events API.
//
//   message.im ──▶ resolve person + their incident ──▶
//     · DPO / lawyer asking a question  → why (rules' reasons) / what-if (evaluate on a modified snapshot)
//     · anyone else (or a statement)    → extract several sourced facts, flag contradictions, propose a one-click confirm
//
// R15: the message is untrusted data. The LLM only reads sentences and maps language to structure; every legal
// result ("why", "what if") is computed by the real rules (evaluate), never by the model.
import { z } from "zod";
import { IncidentSnapshot } from "@/lib/domain";
import type { Fact, Role } from "@/lib/domain";
import { GDPR_FACTS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { evaluate } from "@/lib/regulations/gdpr";
import { extractReplyFacts, interpretCaseQuestion, MODELS, OBLIGATION_IDS } from "@/lib/adapters/mistral";
import { db, listEvents, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { openDm, postDm, section, type Block } from "@/lib/adapters/slack";
import { buildDm, OBLIGATION_LABEL, recordWithRetry, showValue } from "@/lib/services/notify";
import { decisionStatus } from "@/lib/services/decide";

// Minimal shape of a Slack message.im event (only the fields we use).
export const MessageEvent = z.object({
  type: z.literal("message"),
  channel: z.string(),
  user: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  channel_type: z.string().optional(),
});
export type MessageEvent = z.infer<typeof MessageEvent>;

type Person = { name: string; role: Role; slackUserId: string };

const QUESTION_RE = /\?|^\s*(why|pourquoi|comment|how|what if|et si|est-ce|would|serait|si\b)/i;

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

const asArray = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(asArray(a)) === JSON.stringify(asArray(b));

// Coerce a free-text "what if" value to the fact's real type, then validate with its schema. null if it doesn't fit.
export function coerceValue(key: GdprFactKey, raw: string): unknown {
  const def = GDPR_FACTS[key].value as z.ZodType;
  let candidate: unknown = raw.trim();
  if (def instanceof z.ZodBoolean) {
    if (/^(yes|true|oui|1)$/i.test(raw.trim())) candidate = true;
    else if (/^(no|false|non|0)$/i.test(raw.trim())) candidate = false;
    else return null;
  } else if (def instanceof z.ZodNumber) {
    const n = Number(raw.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n)) return null;
    candidate = n;
  } else if (def instanceof z.ZodArray) {
    candidate = raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const parsed = def.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function personBySlackId(userId: string): Promise<Person | null> {
  const { data, error } = await db().from("people").select("name, role, slack_user_id").eq("slack_user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { name: (data as { name: string }).name, role: (data as { role: Role }).role, slackUserId: userId } : null;
}

// The incident this person was most recently DM'd about (DMs don't carry an incident id).
async function latestIncidentFor(userId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("incident_events")
    .select("incident_id")
    .eq("type", "notification")
    .filter("payload->to->>slackUserId", "eq", userId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data as { incident_id: string }).incident_id : null;
}

async function briefOf(incidentId: string): Promise<string | null> {
  let brief: string | null = null;
  for (const { event: e } of await listEvents(incidentId)) if (e.type === "extraction" && e.brief) brief = e.brief;
  return brief;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleMessageEvent(raw: unknown): Promise<void> {
  const e = MessageEvent.safeParse(raw);
  if (!e.success) return;
  const ev = e.data;
  // Ignore the bot's own messages, edits/joins, non-DM, and empty texts.
  if (ev.bot_id || ev.subtype || ev.channel_type !== "im" || !ev.user || !ev.text?.trim()) return;

  const person = await personBySlackId(ev.user);
  if (!person) {
    await postDm(ev.channel, [section("I don't recognise you in the incident response org chart, so I can't record this.")], "unknown user");
    return;
  }
  const incidentId = await latestIncidentFor(ev.user);
  if (!incidentId) {
    await postDm(ev.channel, [section("I don't have an open incident addressed to you right now.")], "no incident");
    return;
  }

  const text = ev.text.trim();
  const isQuestion = (person.role === "dpo" || person.role === "lawyer") && QUESTION_RE.test(text);
  if (isQuestion) await answerCaseQuestion(incidentId, ev.channel, text);
  else await ingestReply(incidentId, person, ev.channel, text);
}

// ---------------------------------------------------------------------------
// Q&A: "why" and "what if" — the rules answer, not the model
// ---------------------------------------------------------------------------

export async function answerCaseQuestion(incidentId: string, channel: string, text: string): Promise<void> {
  const snapshot = await loadSnapshot(incidentId);
  const q = await interpretCaseQuestion(text);

  if (q.kind === "why") {
    const assessment = evaluate(snapshot);
    const targets = q.obligation ? assessment.obligations.filter((o) => o.id === q.obligation) : assessment.obligations;
    const blocks = targets.map((o) =>
      section(
        `*${OBLIGATION_LABEL[o.id] ?? o.id}* — *${o.status.replaceAll("_", " ")}* (${o.legalRefs.join(", ") || "—"})\n` +
          (o.reasons.join("\n") || "No reason recorded.") +
          (o.factsToConfirm.length ? `\n_Facts to confirm: ${o.factsToConfirm.join(", ")}_` : ""),
      ),
    );
    await postDm(channel, blocks.length ? blocks : [section("No obligation matches that question.")], "assessment");
    return;
  }

  if (q.kind === "what_if") {
    const applied: string[] = [];
    const facts = { ...snapshot.facts } as IncidentSnapshot["facts"];
    for (const { factKey, value } of q.overrides) {
      if (!(factKey in GDPR_FACTS)) continue;
      const v = coerceValue(factKey, value);
      if (v === null) continue;
      facts[factKey] = { value: v, state: "confirmed", method: "human", sources: [] } as Fact<unknown>;
      applied.push(`${factKey} = ${showValue(v)}`);
    }
    if (!applied.length) {
      await postDm(channel, [section("I couldn't map that hypothesis to a known fact. Try e.g. _“what if the keys were safe?”_")], "what-if");
      return;
    }
    // The hypothetical is computed by the real rules on a modified snapshot — never guessed.
    const hypothetical = IncidentSnapshot.parse({ ...snapshot, facts: { ...facts }, version: snapshot.version });
    const before = evaluate(snapshot);
    const after = evaluate(hypothetical);
    const lines = OBLIGATION_IDS.map((id) => {
      const b = before.obligations.find((o) => o.id === id);
      const a = after.obligations.find((o) => o.id === id);
      if (!a) return null;
      const changed = b && b.status !== a.status;
      return `• ${OBLIGATION_LABEL[id] ?? id}: *${a.status.replaceAll("_", " ")}*${changed ? ` _(was ${b!.status.replaceAll("_", " ")})_` : ""}`;
    }).filter(Boolean) as string[];
    await postDm(
      channel,
      [section(`*Hypothesis* (computed by the rules, not a guess): ${applied.join(", ")}\n\n${lines.join("\n")}`)],
      "what-if",
    );
    return;
  }

  await postDm(
    channel,
    [section("I can explain the analysis: ask _“why is the CNIL notification required?”_ or _“what if the data were encrypted?”_")],
    "help",
  );
}

// ---------------------------------------------------------------------------
// Free-text facts: extract, flag contradictions, propose a one-click confirm
// ---------------------------------------------------------------------------

export async function ingestReply(incidentId: string, person: Person, channel: string, text: string): Promise<void> {
  const roleKeys = (Object.keys(GDPR_FACTS) as GdprFactKey[]).filter((k) => GDPR_FACTS[k].role === person.role);
  const extracted = await extractReplyFacts(text, roleKeys);
  const keys = Object.keys(extracted) as GdprFactKey[];

  if (!keys.length) {
    // Ambiguous / off-topic: ask the targeted open question(s) this role still owns.
    const snapshot = await loadSnapshot(incidentId);
    const open = roleKeys.filter((k) => {
      const f = snapshot.facts[k];
      return !(f?.state === "confirmed" || f?.dontKnowBy);
    });
    const ask = open.slice(0, 3).map((k) => `• ${GDPR_FACTS[k].question}`).join("\n");
    await postDm(
      channel,
      [section(`I didn't catch a clear answer. ${ask ? `Could you tell me:\n${ask}` : "Nothing is pending from you right now."}`)],
      "follow-up",
    );
    return;
  }

  // Build the facts update from a fresh snapshot; a value that contradicts someone else's confirmed value is disputed.
  const contradictions: { key: string; previous: unknown; now: unknown; by?: string }[] = [];
  let proposed = 0;
  for (let attempt = 0; ; attempt++) {
    const snap = await loadSnapshot(incidentId);
    const facts = { ...snap.facts, severity: snap.severity } as IncidentSnapshot["facts"];
    contradictions.length = 0;
    proposed = 0;
    for (const key of keys) {
      const { value, excerpt } = extracted[key];
      const ex = snap.facts[key];
      if (ex?.state === "confirmed" && ex.value !== null && !sameValue(ex.value, value) && ex.confirmedBy !== person.name) {
        // Two sources disagree: mark the fact contested (counts as unknown in the rules) and alert the DPO.
        facts[key] = { ...ex, state: "disputed", method: "human" } as Fact<unknown>;
        contradictions.push({ key, previous: ex.value, now: value, by: ex.confirmedBy });
      } else {
        facts[key] = { value, state: "proposed", method: "llm", sources: [{ excerpt }] } as Fact<unknown>;
        proposed++;
      }
    }
    try {
      await recordEvent({
        incidentId,
        expectedVersion: snap.version,
        actor: `slack:${person.slackUserId}`,
        idempotencyKey: `slack:reply:${person.slackUserId}:${text.slice(0, 60)}`,
        facts,
        event: {
          type: "extraction",
          status: "ok",
          provenance: MODELS.extract,
          recordedDemo: false,
          brief: null,
          factKeys: keys,
        },
      });
      break;
    } catch (err) {
      if (err instanceof VersionConflict && attempt === 0) continue;
      throw err;
    }
  }

  // Alert the DPO(s) with both versions of each contested fact.
  if (contradictions.length) await alertDpoContradictions(incidentId, person, contradictions);

  // Propose the extracted facts back to the person for a one-click confirm (reuses buildDm's Confirm/Wrong flow).
  const snapshot = await loadSnapshot(incidentId);
  const ctx = {
    snapshot,
    assessment: evaluate(snapshot),
    brief: await briefOf(incidentId),
    now: new Date(),
    decisions: decisionStatus(await listEvents(incidentId)),
  };
  const dm = buildDm(person.role, ctx);
  const intro = section(
    `Thanks — I read your message and noted ${proposed} fact${proposed === 1 ? "" : "s"} to confirm` +
      (contradictions.length ? `, and flagged ${contradictions.length} that conflict with earlier answers (the DPO is alerted).` : "."),
  );
  const blocks: Block[] = [intro, ...(dm?.blocks ?? [])].slice(0, 50);
  const slack = await postDm(channel, blocks, dm?.text ?? "Facts to confirm");
  await recordWithRetry(incidentId, (await loadSnapshot(incidentId)).version, {
    actor: `slack:${person.slackUserId}`,
    idempotencyKey: `slack:reply-dm:${person.slackUserId}:${slack.ts}`,
    event: {
      type: "notification",
      to: { role: person.role, name: person.name, slackUserId: person.slackUserId },
      kind: "questions",
      questionIds: dm?.questionIds ?? [],
      preview: "Facts to confirm from a free-text reply",
      slack,
      delivered: true,
    },
  });
}

async function alertDpoContradictions(
  incidentId: string,
  person: Person,
  contradictions: { key: string; previous: unknown; now: unknown; by?: string }[],
): Promise<void> {
  const lines = contradictions
    .map(
      (c) =>
        `• *${c.key}*: ${person.name} now says *${showValue(c.now)}*, but it was confirmed as *${showValue(c.previous)}*${c.by ? ` by ${c.by}` : ""}. Marked contested (counts as unknown).`,
    )
    .join("\n");
  const msg = `*Contradiction on the incident*\n${lines}\n_Please reconcile with the people concerned._`;
  const { data, error } = await db().from("people").select("name, slack_user_id").eq("role", "dpo");
  if (error) throw new Error(error.message);
  for (const dpo of data as { name: string; slack_user_id: string | null }[]) {
    let slack: { channel: string; ts: string } | null = null;
    let err: string | undefined;
    try {
      if (!dpo.slack_user_id) throw new Error("no slack_user_id");
      slack = await postDm(await openDm(dpo.slack_user_id), [section(msg)], msg);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    await recordWithRetry(incidentId, (await loadSnapshot(incidentId)).version, {
      actor: `slack:${person.slackUserId}`,
      idempotencyKey: `slack:contradiction:${person.slackUserId}:${slack?.ts ?? dpo.name}:${contradictions.map((c) => c.key).join(",")}`,
      event: {
        type: "notification",
        to: { role: "dpo", name: dpo.name, ...(dpo.slack_user_id && { slackUserId: dpo.slack_user_id }) },
        kind: "assessment",
        questionIds: [],
        preview: msg,
        slack,
        delivered: !!slack,
        ...(err && { error: err }),
      },
    });
  }
}
