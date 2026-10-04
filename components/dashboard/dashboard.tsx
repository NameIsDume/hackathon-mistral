"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import type { ScenarioTrack } from "@/lib/dashboard/mock";
import type { EventRow } from "@/lib/dashboard/view";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { AppShell } from "./app-shell";
import { BlockersBox } from "./blockers-box";
import { Disclosure } from "./disclosure";
import { Hero } from "./hero";
import { ObligationClocks } from "./obligation-clocks";
import { PeopleBox } from "./people-box";
import { ReviewSection } from "./review-section";
import { RoleThreads } from "./role-threads";
import { EventTimeline } from "./event-timeline";
import { blockers, peopleInvolved } from "@/lib/dashboard/insights";

type Incident = {
  id: string;
  company: string;
  title: string;
  brief: string;
  severity: Severity;
  firstSignalAt: string;
  awarenessAt: string | null;
};

type Props = {
  incident: Incident;
  severity: Fact<Severity>;
  obligations: Obligation[];
  events: EventRow[];
  tracks: ScenarioTrack[];
};

// Maps a raw incident_events row (payload column holds the union's non-audit fields).
function rowToEvent(row: Record<string, unknown>): EventRow {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return { id: row.id as number, at: row.at as string, actor: row.actor as string, type: row.type, ...payload } as EventRow;
}

export function Dashboard({ incident, severity, obligations, events: initialEvents, tracks }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [events, setEvents] = useState(initialEvents);
  const [live, setLive] = useState(false);

  // Live countdown: a single second-resolution tick drives every clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Realtime append when Supabase env is present; otherwise the fixtures stand in.
  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
    setLive(true);
    const channel = supabase
      .channel(`incident:${incident.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incident_events", filter: `incident_id=eq.${incident.id}` },
        (payload) => setEvents((prev) => [...prev, rowToEvent(payload.new as Record<string, unknown>)]),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [incident.id]);

  const timeline = { firstSignalAt: incident.firstSignalAt, awarenessAt: incident.awarenessAt };
  const blockerCount = blockers(events, obligations, incident.awarenessAt).length;
  const peopleCount = peopleInvolved(events).length;

  return (
    <AppShell title={incident.title} company={incident.company} severity={incident.severity} live={live}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-5 sm:p-7">
        <Hero
          title={incident.title}
          brief={incident.brief}
          severity={incident.severity}
          obligations={obligations}
          timeline={timeline}
          now={now}
        />

        <div className="grid gap-5 md:grid-cols-2">
          <PeopleBox events={events} />
          <BlockersBox events={events} obligations={obligations} awarenessAt={incident.awarenessAt} />
        </div>

        <Disclosure label="Journal complet" count={events.length}>
          <EventTimeline events={events} />
        </Disclosure>

        <Disclosure label="Détails & obligations">
          <div className="flex flex-col gap-8">
            <ObligationClocks obligations={obligations} timeline={timeline} tracks={tracks} now={now} />
            <ReviewSection
              incidentId={incident.id}
              severity={severity}
              firstSignalAt={incident.firstSignalAt}
              awarenessAt={incident.awarenessAt}
              live={live}
            />
            <RoleThreads events={events} />
          </div>
        </Disclosure>
      </div>
    </AppShell>
  );
}
