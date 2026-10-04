"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import type { ScenarioTrack } from "@/lib/dashboard/mock";
import type { EventRow } from "@/lib/dashboard/view";
import type { Fact, Obligation, Severity } from "@/lib/domain";
import { BlockersBox } from "./blockers-box";
import { Disclosure } from "./disclosure";
import { Hero } from "./hero";
import { Kanban } from "./kanban";
import { ObligationClocks } from "./obligation-clocks";
import { ReviewSection } from "./review-section";
import { RoleThreads } from "./role-threads";
import { EventTimeline } from "./event-timeline";

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
  nowSeed: number; // seeded by the server so SSR and first client render match (no hydration drift)
};

// Maps a raw incident_events row (payload column holds the union's non-audit fields).
function rowToEvent(row: Record<string, unknown>): EventRow {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return { id: row.id as number, at: row.at as string, actor: row.actor as string, type: row.type, ...payload } as EventRow;
}

export function Dashboard({ incident, severity, obligations, events: initialEvents, tracks, nowSeed }: Props) {
  const [now, setNow] = useState(nowSeed);
  const [events, setEvents] = useState(initialEvents);
  // Resolved once at mount; consistent between SSR and client (env is inlined), so no hydration flash.
  const [live] = useState(() => getSupabaseBrowser() !== null);

  // Live countdown: a single second-resolution tick drives every clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Realtime append when Supabase env is present; otherwise the fixtures stand in.
  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
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
  const [journalOpen, setJournalOpen] = useState(false);

  const openJournal = () => {
    setJournalOpen(true);
    requestAnimationFrame(() => document.getElementById("journal")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 p-5 sm:p-7">
        <Hero
          title={incident.title}
          brief={incident.brief}
          severity={incident.severity}
          live={live}
          obligations={obligations}
          tracks={tracks}
          timeline={timeline}
          now={now}
          onOpenJournal={openJournal}
        />

        <Kanban events={events} obligations={obligations} severity={severity} awarenessAt={incident.awarenessAt} />

        <Disclosure label="Points de blocage">
          <BlockersBox events={events} obligations={obligations} awarenessAt={incident.awarenessAt} />
        </Disclosure>

        <Disclosure id="journal" label="Journal de l'incident" count={events.length} open={journalOpen} onOpenChange={setJournalOpen}>
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
    </div>
  );
}
