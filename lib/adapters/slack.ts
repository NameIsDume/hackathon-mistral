// Server-only Slack adapter: request signing, Web API calls (plain fetch), Block Kit builders.
// No domain logic here: what goes into a DM is decided by lib/services/notify.ts.
import { createHmac, timingSafeEqual } from "node:crypto";

// Slack request signing v0: HMAC-SHA256 of "v0:<timestamp>:<raw body>", timestamp within 5 minutes.
export function verifySlackSignature(rawBody: string, headers: Headers, secret: string, now = Date.now() / 1000): boolean {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!secret || !ts || !sig || !/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > 300) return false;
  const expected = Buffer.from("v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex"));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class SlackError extends Error {}

async function call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string };
  if (!json.ok) throw new SlackError(`${method}: ${json.error ?? "unknown_error"}`);
  return json as T;
}

export type Block = Record<string, unknown>;

export async function openDm(userId: string): Promise<string> {
  return (await call<{ channel: { id: string } }>("conversations.open", { users: userId })).channel.id;
}

export async function postDm(channel: string, blocks: Block[], text: string, threadTs?: string): Promise<{ channel: string; ts: string }> {
  const r = await call<{ channel: string; ts: string }>("chat.postMessage", { channel, blocks, text, ...(threadTs && { thread_ts: threadTs }) });
  return { channel: r.channel, ts: r.ts };
}

export async function updateMessage(channel: string, ts: string, blocks: Block[], text: string): Promise<void> {
  await call("chat.update", { channel, ts, blocks, text });
}

// Must run within 3 s of the click that produced trigger_id, i.e. before the interaction is acknowledged.
export async function openView(triggerId: string, view: Block): Promise<void> {
  await call("views.open", { trigger_id: triggerId, view });
}

// users.lookupByEmail only takes form/query arguments, not JSON.
export async function lookupUserIdByEmail(email: string): Promise<string> {
  const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const json = (await res.json()) as { ok: boolean; error?: string; user?: { id: string } };
  if (!json.ok || !json.user) throw new SlackError(`users.lookupByEmail: ${json.error ?? "unknown_error"}`);
  return json.user.id;
}

// ---------------------------------------------------------------------------
// Block Kit
// ---------------------------------------------------------------------------

export type Answer = "yes" | "no" | "unknown";
export const ANSWER_LABEL: Record<Answer, string> = { yes: "Yes", no: "No", unknown: "I don't know" };

// Section text is capped at 3000 characters by Slack.
export const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) } });
export const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150) } });

export function briefBlocks(title: string, paragraphs: string[]): Block[] {
  return [header(title), ...paragraphs.filter(Boolean).map(section)];
}

// One question = a section + an actions block (block_id = factKey, so the answer can replace it in place).
export function questionBlocks(incidentId: string, factKey: string, text: string): Block[] {
  return [
    section(`*${text}*`),
    {
      type: "actions",
      block_id: factKey,
      elements: (Object.keys(ANSWER_LABEL) as Answer[]).map((answer) => ({
        type: "button",
        action_id: `answer_${answer}`,
        text: { type: "plain_text", text: ANSWER_LABEL[answer] },
        value: JSON.stringify({ incidentId, factKey, answer }),
      })),
    },
  ];
}

export const plain = (text: string, max = 75): Block => ({ type: "plain_text", text: text.slice(0, max) });
export const option = (value: string, text = value.replaceAll("_", " ")): Block => ({ text: plain(text), value });

export const button = (text: string, actionId: string, value: string, style?: "primary" | "danger"): Block => ({
  type: "button",
  action_id: actionId,
  text: plain(text),
  value,
  ...(style && { style }),
});

// A Markdown document (lib/regulations/gdpr/templates.ts toMarkdown) as readable blocks: title as header,
// headings and bold in mrkdwn, split into sections under the 3000-character cap, at most 50 blocks per message.
export function markdownBlocks(md: string): Block[] {
  const [title, ...rest] = md.trim().split("\n");
  const body = rest.join("\n").replace(/^#+ (.*)$/gm, "*$1*").replace(/\*\*(.+?)\*\*/g, "*$1*").trim();
  const chunks: string[] = [];
  for (const line of body.split("\n")) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + line.length + 1 <= 3000) chunks[chunks.length - 1] = `${last}\n${line}`;
    else chunks.push(line);
  }
  return [header(title.replace(/^# /, "")), ...chunks.filter((c) => c.trim()).map(section)].slice(0, 50);
}
