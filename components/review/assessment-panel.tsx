"use client";

import { useEffect, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Clock, formatParis } from "@/lib/clocks";
import type { Assessment, IncidentSnapshot, Obligation } from "@/lib/domain";
import { REVIEW_SAVED, SEVERITY_LABELS } from "./shared";

type Data = { snapshot: IncidentSnapshot; assessment: Assessment; clocks: Record<string, Clock> };

const TITLES: Record<string, string> = {
  "gdpr.record_breach": "Record in the breach register",
  "gdpr.notify_controller": "Inform the controller",
  "gdpr.notify_authority": "Notify the supervisory authority (CNIL)",
  "gdpr.inform_subjects": "Inform the data subjects",
};

function StatusBadge({ o }: { o: Obligation }) {
  if (o.status === "required")
    return o.factsToConfirm.length ? <Badge variant="secondary">Required, facts to confirm</Badge> : <Badge variant="destructive">Required</Badge>;
  if (o.status === "not_required") return <Badge variant="outline">Not required</Badge>;
  if (o.status === "controller_duty") return <Badge variant="outline">Controller&apos;s duty</Badge>;
  if (o.status === "controller_decides") return <Badge variant="outline">Controller decides</Badge>;
  return <Badge variant="outline" className="border-dashed">Undetermined</Badge>;
}

function hm(ms: number) {
  const m = Math.floor(Math.abs(ms) / 60_000);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function ClockLine({ clock, now }: { clock: Clock; now: number }) {
  const provisional = clock.provisional && <> (provisional, from first signal)</>;
  if (clock.dueAt === null) return <p>Without undue delay{provisional}</p>;
  const left = Date.parse(clock.dueAt) - now;
  return (
    <p className={left < 0 ? "font-medium text-destructive" : undefined}>
      {left < 0 ? `Overdue by ${hm(left)}` : `${hm(left)} left`} · due {formatParis(clock.dueAt)} (Paris){provisional}
    </p>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="list-disc pl-5">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function AssessmentPanel({ incidentId }: { incidentId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const titleId = useId();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/assessment?incidentId=${encodeURIComponent(incidentId)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
        const d = (await res.json()) as Data;
        if (!alive) return;
        setData(d);
        setError(null);
        setNow(Date.now());
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    load();
    window.addEventListener(REVIEW_SAVED, load);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      window.removeEventListener(REVIEW_SAVED, load);
      clearInterval(tick);
    };
  }, [incidentId]);

  if (!data)
    return (
      <Card>
        <CardContent role="status" aria-live="polite" className={error ? "text-destructive" : "text-muted-foreground"}>
          {error ? `Assessment unavailable: ${error}` : "Loading assessment…"}
        </CardContent>
      </Card>
    );

  const { snapshot, assessment, clocks } = data;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <div>
        <h2 id={titleId} className="text-lg font-semibold">
          GDPR assessment
        </h2>
        <p className="text-sm text-muted-foreground">
          Applicability: {assessment.applicability.replace("_", " ")} · severity{" "}
          {snapshot.severity.value ? SEVERITY_LABELS[snapshot.severity.value] : "unknown"} ({snapshot.severity.state}) · facts v
          {assessment.factsVersion} · rules {assessment.moduleVersion}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Refresh failed: {error}
          </p>
        )}
      </div>
      {assessment.obligations.map((o) => (
        <Card key={o.id} size="sm">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {TITLES[o.id] ?? o.id} <StatusBadge o={o} />
            </CardTitle>
            <CardDescription>{o.legalRefs.join(" · ")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {clocks[o.id] && <ClockLine clock={clocks[o.id]} now={now} />}
            <List title="Reasons" items={o.reasons} />
            <List title="Facts to confirm" items={o.factsToConfirm} />
            <List title="Cited facts" items={o.citedFacts} />
            <List title="Blocking questions" items={o.blockingQuestions} />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
