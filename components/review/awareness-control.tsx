"use client";

import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatParis } from "@/lib/clocks";
import { DEFAULT_REVIEWER, parisLocalToIso, postJson, type Reviewer, toParisLocal } from "./shared";

export function AwarenessControl({
  incidentId,
  firstSignalAt,
  awarenessAt,
  by = DEFAULT_REVIEWER,
}: {
  incidentId: string;
  firstSignalAt: string;
  awarenessAt: string | null;
  by?: Reviewer;
}) {
  const [saved, setSaved] = useState(awarenessAt);
  const [value, setValue] = useState(toParisLocal(awarenessAt ?? firstSignalAt));
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const id = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const at = parisLocalToIso(value);
    setState({ busy: true });
    try {
      await postJson("/api/awareness", { incidentId, at, by });
      setSaved(at);
      setState({ busy: false });
    } catch (err) {
      setState({ busy: false, error: (err as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Awareness time</CardTitle>
        <CardDescription>
          When the organisation became aware of the breach: the 72 h clock starts here. A correction is recorded and never restarts the clock.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm">
          {saved ? (
            <>
              Aware since <strong>{formatParis(saved)}</strong> (Paris time)
            </>
          ) : (
            <>
              <Badge variant="outline">provisional (from first signal)</Badge> {formatParis(firstSignalAt)}
            </>
          )}
        </p>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={id} className="text-sm font-medium">
              Became aware at (Europe/Paris)
            </label>
            <Input
              id={id}
              type="datetime-local"
              required
              value={value}
              min={toParisLocal(firstSignalAt)}
              onChange={(e) => setValue(e.target.value)}
              className="w-auto"
            />
          </div>
          <Button type="submit" disabled={!value || state.busy}>
            {saved ? "Correct awareness time" : "Set awareness time"}
          </Button>
          <p role="status" aria-live="polite" className="text-sm text-destructive">
            {state.error}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
