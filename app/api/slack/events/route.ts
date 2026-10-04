// Slack Events API (#55): free-text replies typed in the bot's DMs (event message.im).
// Verify the signature on the raw body, answer Slack's url_verification challenge, ack within 3 s,
// then do the work in after(). Logic: lib/services/slack-events.ts.
import { after } from "next/server";
import { verifySlackSignature } from "@/lib/adapters/slack";
import { handleMessageEvent } from "@/lib/services/slack-events";

export const maxDuration = 60; // Mistral extraction (12 s) + database writes + DM, all after the ack

export async function POST(request: Request) {
  const raw = await request.text();

  let body: { type?: string; challenge?: string; event?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // url_verification is sent before any token exists for this URL; it is still signed, so verify first.
  if (!verifySlackSignature(raw, request.headers, process.env.SLACK_SIGNING_SECRET ?? "")) {
    return new Response("invalid signature", { status: 401 });
  }

  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return new Response(body.challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }

  // We ack fast; a Slack retry (we were slow once) must not re-post DMs, so skip retries — the first run owns it.
  if (request.headers.get("x-slack-retry-num")) return new Response(null, { status: 200 });

  if (body.type === "event_callback" && body.event) {
    after(() => handleMessageEvent(body.event).catch((e) => console.error("slack event failed", e)));
  }
  return new Response(null, { status: 200 });
}
