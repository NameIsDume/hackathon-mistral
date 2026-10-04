"use client";

import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Fact, Severity } from "@/lib/domain";
import { formatParis } from "@/lib/clocks";
import { DEFAULT_REVIEWER, postJson, type Reviewer, SEVERITY_LABELS } from "./shared";

const LEVELS = Object.keys(SEVERITY_LABELS) as Severity[];

export function SeverityControl({
  incidentId,
  current,
  proposedBy = "AI",
  by = DEFAULT_REVIEWER,
}: {
  incidentId: string;
  current: Fact<Severity>; // snapshot.severity
  proposedBy?: string; // who proposed the value, e.g. the model id
  by?: Reviewer; // who is confirming
}) {
  const [fact, setFact] = useState(current);
  const [choice, setChoice] = useState<Severity | null>(current.value);
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const name = useId();
  const confirmed = fact.state === "confirmed";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!choice) return;
    setState({ busy: true });
    try {
      await postJson("/api/severity", { incidentId, value: choice, by });
      setFact({ value: choice, state: "confirmed", method: "human", sources: [], confirmedBy: by.name, confirmedAt: new Date().toISOString() });
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: (err as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Severity</CardTitle>
        <CardDescription>
          {confirmed ? (
            <>
              Confirmed by {fact.confirmedBy}
              {fact.confirmedAt && ` on ${formatParis(fact.confirmedAt)}`}
            </>
          ) : (
            <>Proposed by {proposedBy}, not yet confirmed by a human</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Severity level</legend>
            {LEVELS.map((level) => (
              <label
                key={level}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm has-checked:border-primary has-checked:bg-primary/10 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
              >
                <input type="radio" name={name} value={level} checked={choice === level} onChange={() => setChoice(level)} className="accent-primary" />
                {SEVERITY_LABELS[level]}
                {fact.value === level && <Badge variant={confirmed ? "default" : "outline"}>{confirmed ? "confirmed" : "proposed"}</Badge>}
              </label>
            ))}
          </fieldset>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!choice || state.busy}>
              {choice && choice !== fact.value ? "Correct severity" : "Confirm severity"}
            </Button>
            <p role="status" aria-live="polite" className="text-sm text-destructive">
              {state.error}
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
