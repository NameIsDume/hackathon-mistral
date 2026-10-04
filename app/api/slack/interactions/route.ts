// Slack button clicks (#13): verify the signature on the raw body, ack at once, record the answer in after().
import { after } from "next/server";
import { z } from "zod";
import type { Role } from "@/lib/domain";
import { GDPR_FACTS, type GdprFactKey } from "@/lib/regulations/gdpr/facts";
import { db, loadSnapshot, recordEvent, VersionConflict } from "@/lib/adapters/supabase";
import { ANSWER_LABEL, section, updateMessage, verifySlackSignature, type Block } from "@/lib/adapters/slack";
import { isBooleanFact } from "@/lib/services/notify";

const Payload = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  actions: z.array(z.object({ value: z.string(), action_ts: z.string() })).min(1),
  container: z.object({ channel_id: z.string(), message_ts: z.string() }),
  message: z.object({ blocks: z.array(z.record(z.string(), z.unknown())) }).optional(),
  response_url: z.string().optional(),
});
type Payload = z.infer<typeof Payload>;
const Value = z.object({ incidentId: z.uuid(), factKey: z.string().refine(isBooleanFact), answer: z.enum(["yes", "no", "unknown"]) });
type Value = z.infer<typeof Value>;

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySlackSignature(raw, request.headers, process.env.SLACK_SIGNING_SECRET ?? "")) return new Response("invalid signature", { status: 401 });

  let p: Payload, v: Value;
  try {
    p = Payload.parse(JSON.parse(new URLSearchParams(raw).get("payload") ?? ""));
    v = Value.parse(JSON.parse(p.actions[0].value));
  } catch {
    return new Response("unsupported payload", { status: 400 });
  }
  after(() => handle(p, v).catch((e) => console.error("slack interaction failed", e)));
  return new Response(null, { status: 200 });
}

// Ephemeral reply through the interaction's response_url (only the clicker sees it, the DM is untouched).
async function tell(p: Payload, text: string) {
  if (p.response_url)
    await fetch(p.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
}

async function handle(p: Payload, v: Value) {
  const role: Role = GDPR_FACTS[v.factKey as GdprFactKey].role;
  const { data: person, error } = await db()
    .from("people")
    .select("name, role, slack_user_id")
    .eq("slack_user_id", p.user.id)
    .eq("role", role)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!person) return tell(p, "This question is addressed to someone else: your answer was not recorded.");
  const by = { role, name: (person as { name: string }).name, slackUserId: p.user.id };

  // Rebuild the facts from a fresh snapshot on each attempt: record_event replaces the whole facts object.
  for (let attempt = 0; ; attempt++) {
    const snap = await loadSnapshot(v.incidentId);
    const old = snap.facts[v.factKey] ?? { value: null, state: "proposed" as const, method: "human" as const, sources: [] };
    const fact =
      v.answer === "unknown"
        ? { ...old, value: null } // "I don't know": the value becomes unknown, the state is left as is
        : { ...old, value: v.answer === "yes", state: "confirmed" as const, method: "human" as const, confirmedBy: by.name, confirmedAt: new Date().toISOString() };
    try {
      await recordEvent({
        incidentId: v.incidentId,
        expectedVersion: snap.version,
        actor: `slack:${p.user.id}`,
        idempotencyKey: `slack:${p.actions[0].action_ts}:${p.user.id}`,
        facts: { ...snap.facts, severity: snap.severity, [v.factKey]: fact },
        event: { type: "answer", by, factKey: v.factKey, answer: v.answer, via: "slack" },
      });
      break;
    } catch (e) {
      if (e instanceof VersionConflict && attempt === 0) continue;
      await tell(p, "Your answer could not be recorded, please try again.");
      throw e;
    }
  }

  const done = `Answer recorded: ${ANSWER_LABEL[v.answer]}`;
  const blocks = (p.message?.blocks ?? []).map((b) => (b.block_id === v.factKey ? section(`_${done}_`) : b)) as Block[];
  await updateMessage(p.container.channel_id, p.container.message_ts, blocks.length ? blocks : [section(done)], done);
}
