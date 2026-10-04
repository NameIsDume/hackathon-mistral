// Slack Events API (#55): verify the signature on the raw body, answer url_verification, ack within 3 s and handle
// direct messages (message.im) in after(). Retries are ignored: the first delivery was acked, its work runs in after().
// Logic: lib/services/conversation.ts.
import { after } from "next/server";
import { verifySlackSignature } from "@/lib/adapters/slack";
import { handleDm } from "@/lib/services/conversation";

export const maxDuration = 60; // one Mistral call (25 s budget) + database writes + the reply

type Body = {
  type?: string;
  challenge?: string;
  event?: { type?: string; channel_type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel?: string; ts?: string; thread_ts?: string };
};

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySlackSignature(raw, request.headers, process.env.SLACK_SIGNING_SECRET ?? "")) return new Response("invalid signature", { status: 401 });
  let body: Body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("unsupported payload", { status: 400 });
  }
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
  if (request.headers.get("x-slack-retry-num")) return new Response(null, { status: 200 });

  const e = body.event;
  // A person's own message only: no bot (ours included), no edit/delete/join subtypes.
  if (body.type === "event_callback" && e?.type === "message" && e.channel_type === "im" && !e.bot_id && !e.subtype && e.user && e.text?.trim() && e.channel && e.ts) {
    const m = { user: e.user, text: e.text.slice(0, 4000), channel: e.channel, ts: e.ts, threadTs: e.thread_ts };
    after(() => handleDm(m).catch((err) => console.error("slack dm failed", err)));
  }
  return new Response(null, { status: 200 });
}
