"use client";

// DPO sign-off for one GDPR obligation: computed recommendation, choice, written reasons, signature.
import { useCallback, useEffect, useId, useState } from "react";
import type { Assessment } from "@/lib/domain";
import type { DecisionStatus } from "@/lib/services/decide";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ObligationId = "gdpr.notify_authority" | "gdpr.inform_subjects" | "gdpr.notify_controller";
type Choice = "notify" | "do_not_notify";

const TITLES: Record<ObligationId, string> = {
  "gdpr.notify_authority": "Notify the supervisory authority (Art. 33)",
  "gdpr.inform_subjects": "Inform the people concerned (Art. 34)",
  "gdpr.notify_controller": "Inform the controller (Art. 33(2))",
};
const STATUS_LABEL = {
  required: "Required",
  not_required: "Not required",
  undetermined: "Undetermined",
  controller_duty: "Controller's duty",
  controller_decides: "Controller decides",
} as const;
const MIN_REASONS = 20; // mirrors MIN_REASONS_LENGTH in lib/services/decide.ts (server-only module)

export function DecisionForm({
  incidentId,
  obligationId,
  signerName = "DPO",
}: {
  incidentId: string;
  obligationId: ObligationId;
  signerName?: string;
}) {
  const id = useId();
  const [data, setData] = useState<{ assessment: Assessment; decisions: DecisionStatus[] } | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [reasons, setReasons] = useState("");
  const [name, setName] = useState(signerName);
  const [override, setOverride] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/decisions?incidentId=${encodeURIComponent(incidentId)}`, { cache: "no-store" });
    if (res.ok) setData(await res.json());
    else setError((await res.json().catch(() => null))?.error ?? `Loading failed (${res.status})`);
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / incident change
    void load();
  }, [load]);

  const obligation = data?.assessment.obligations.find((o) => o.id === obligationId);
  const recorded = data?.decisions.find((d) => d.obligationId === obligationId);
  const needsOverride =
    choice === "do_not_notify" && obligation?.status === "required" && obligation.factsToConfirm.length === 0;
  const canSign = !!choice && reasons.trim().length >= MIN_REASONS && name.trim() !== "" && (!needsOverride || override) && !pending;

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (!canSign) return;
    setPending(true);
    setError(null);
    const res = await fetch("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incidentId,
        obligationId,
        choice,
        reasons,
        by: { role: "dpo", name: name.trim() },
        overrideRecommendation: needsOverride ? override : undefined,
      }),
    });
    if (res.ok) {
      setReasons("");
      setOverride(false);
      await load();
    } else setError((await res.json().catch(() => null))?.error ?? `Signature failed (${res.status})`);
    setPending(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{TITLES[obligationId]}</CardTitle>
        <CardDescription>
          {obligation ? (
            <span className="flex flex-wrap items-center gap-2">
              Computed recommendation:
              <Badge variant={obligation.status === "required" ? "destructive" : "secondary"}>
                {STATUS_LABEL[obligation.status]}
                {obligation.status === "required" && obligation.factsToConfirm.length > 0 ? ", facts to confirm" : ""}
              </Badge>
            </span>
          ) : (
            "Loading the recommendation…"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {obligation && (
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {obligation.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
            {obligation.factsToConfirm.length > 0 && <li>Facts to confirm: {obligation.factsToConfirm.join(", ")}</li>}
          </ul>
        )}

        {recorded && (
          <section aria-label="Recorded decision" className="rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              Decision: {recorded.decision.choice === "notify" ? "notify" : "do not notify"}
              <Badge variant={recorded.status === "current" ? "outline" : "destructive"}>
                {recorded.status === "current" ? "Current" : "To re-evaluate"}
              </Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              Signed by {recorded.decision.by.name} ({recorded.decision.by.role}) on {new Date(recorded.at).toLocaleString()} · facts
              v{recorded.decision.factsVersion} · rules {recorded.decision.moduleVersion}
            </p>
            <p className="mt-2 whitespace-pre-wrap">{recorded.decision.reasons}</p>
            {recorded.status === "to_re_evaluate" && (
              <p className="mt-2 text-destructive">Facts changed after this decision: review it and sign again.</p>
            )}
          </section>
        )}

        <form onSubmit={sign} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{recorded ? "New decision" : "Decision"}</legend>
            {(["notify", "do_not_notify"] as const).map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="radio" name={`${id}-choice`} value={c} checked={choice === c} onChange={() => setChoice(c)} />
                {c === "notify" ? "Notify" : "Do not notify"}
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-reasons`} className="text-sm font-medium">
              Reasons (required)
            </label>
            <Textarea
              id={`${id}-reasons`}
              required
              minLength={MIN_REASONS}
              value={reasons}
              onChange={(e) => setReasons(e.target.value)}
              aria-describedby={`${id}-hint`}
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {choice === "do_not_notify"
                ? "Art. 33(5): a decision not to notify must be documented. Explain why the breach is unlikely to result in a risk."
                : `At least ${MIN_REASONS} characters; recorded in the breach register.`}
            </p>
          </div>

          {needsOverride && (
            <label className="flex items-start gap-2 text-sm text-destructive">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-0.5" />
              I override the recommendation: the computed status is &quot;required&quot; on confirmed facts.
            </label>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-signer`} className="text-sm font-medium">
              Signer (DPO)
            </label>
            <Input id={`${id}-signer`} required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={!canSign} className="self-start">
            {pending ? "Signing…" : "Sign (DPO)"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
