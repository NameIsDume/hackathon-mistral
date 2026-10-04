// Slack clicks and modal submissions (#13, #39): verify the signature on the raw body, do what Slack waits for
// (views.open, modal validation) before the ack, then the rest in after(). Logic: lib/services/slack-actions.ts.
import { after } from "next/server";
import { z } from "zod";
import { verifySlackSignature } from "@/lib/adapters/slack";
import { handleInteraction, type Outcome } from "@/lib/services/slack-actions";

export const maxDuration = 60; // drafts after a decision call Mistral (12 s budget) then post to Slack

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySlackSignature(raw, request.headers, process.env.SLACK_SIGNING_SECRET ?? "")) return new Response("invalid signature", { status: 401 });

  let outcome: Outcome;
  try {
    outcome = await handleInteraction(JSON.parse(new URLSearchParams(raw).get("payload") ?? ""));
  } catch (e) {
    if (e instanceof z.ZodError || e instanceof SyntaxError) return new Response("unsupported payload", { status: 400 });
    console.error("slack interaction failed", e);
    return new Response(null, { status: 200 }); // e.g. views.open failed: Slack would only retry the same click
  }
  const { body, later } = outcome;
  if (later) after(() => later().catch((e) => console.error("slack interaction failed", e)));
  return body ? Response.json(body) : new Response(null, { status: 200 });
}
