import { z } from "zod";
import { requireDemoKey } from "@/lib/demo-auth";
import { ingestSignal, IntakeInput } from "@/lib/services/ingest";

export const maxDuration = 30; // 12 s Mistral budget + database writes

export async function POST(request: Request) {
  const denied = requireDemoKey(request);
  if (denied) return denied;

  const body = IntakeInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: z.prettifyError(body.error) }, { status: 400 });

  const result = await ingestSignal(body.data);
  return Response.json(result, { status: result.status === "replayed" ? 200 : 201 });
}
