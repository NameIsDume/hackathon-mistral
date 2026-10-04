import { after } from "next/server";
import { z } from "zod";
import { requireDemoKey } from "@/lib/demo-auth";
import { ingestSignal, IntakeInput } from "@/lib/services/ingest";
import { afterIntake } from "@/lib/services/triggers";

export const maxDuration = 60; // 12 s Mistral budget + database writes, then the DM wave in after()

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;

  const body = IntakeInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

  const result = await ingestSignal(body.data);
  // DMs go out once the response is sent (#40); a replay sends nothing.
  if (result.status === "created") after(() => afterIntake(result).catch((e) => console.error("intake notify failed", e)));
  return Response.json(result, { status: result.status === "replayed" ? 200 : 201 });
}
