// `/incident <description>` (#40): verify the signature, ack within Slack's 3 s with an ephemeral reply,
// then intake (signal connector "slack") and the DM wave in after().
import { after } from "next/server";
import { db } from "@/lib/adapters/supabase";
import { verifySlackSignature } from "@/lib/adapters/slack";
import { ingestSignal, IntakeInput } from "@/lib/services/ingest";
import { afterIntake } from "@/lib/services/triggers";

export const maxDuration = 60; // 12 s Mistral budget + database writes + the DM wave, all after the ack

const ephemeral = (text: string) => Response.json({ response_type: "ephemeral", text });

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySlackSignature(raw, request.headers, process.env.SLACK_SIGNING_SECRET ?? "")) return new Response("invalid signature", { status: 401 });

  const f = new URLSearchParams(raw);
  const [userId, userName, triggerId, responseUrl] = ["user_id", "user_name", "trigger_id", "response_url"].map((k) => f.get(k) ?? "");
  const input = IntakeInput.safeParse({ text: f.get("text") ?? "", externalId: triggerId, actor: `${userName || userId} (slack:${userId})` });
  if (!userId || !triggerId || !input.success)
    return ephemeral("Usage: `/incident <what happened, when, which data>` (up to 4000 characters).");

  after(() => report(input.data, userId, responseUrl).catch((e) => console.error("slash command intake failed", e)));
  return ephemeral("Received, the response team is being alerted.");
}

async function report(input: IntakeInput, userId: string, responseUrl: string) {
  try {
    // Who reported: the org chart name when this Slack user is in it, else the Slack handle.
    const { data: person } = await db().from("people").select("name").eq("slack_user_id", userId).limit(1).maybeSingle();
    const actor = person ? `${(person as { name: string }).name} (slack:${userId})` : input.actor;
    await afterIntake(await ingestSignal({ ...input, actor }, "slack"));
  } catch (e) {
    // The reporter must know the report did not go through (the signal may not be recorded).
    if (responseUrl.startsWith("https://hooks.slack.com/"))
      await fetch(responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", text: "Your report could not be recorded. Please try again or alert the DPO directly." }),
      });
    throw e;
  }
}
