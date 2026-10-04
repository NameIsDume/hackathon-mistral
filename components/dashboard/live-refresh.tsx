"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

// Realtime -> router.refresh(): the server reloads the incident and re-runs the real
// rules, so the page never recomputes anything client-side. With an incidentId it
// follows that incident (new events, facts/version updates); without, any incident
// change (new incident, new brief, confirmed facts). Debounced: one answer = several rows.
export function LiveRefresh({ incidentId }: { incidentId?: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    if (!supabase) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 500);
    };
    const channel = supabase.channel(`live:${incidentId ?? "all"}`);
    if (incidentId)
      channel
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "incident_events", filter: `incident_id=eq.${incidentId}` }, refresh)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "incidents", filter: `id=eq.${incidentId}` }, refresh);
    else channel.on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, refresh);
    channel.subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [incidentId, router]);

  return null;
}
