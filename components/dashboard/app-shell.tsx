"use client";

import { Activity, BookText, FileText, LayoutDashboard, Monitor, Scale, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/dashboard/view";
import type { Severity } from "@/lib/domain";
import { cn } from "@/lib/utils";

const NAV = [
  { label: "Tableau de bord", icon: LayoutDashboard, active: true },
  { label: "Incidents", icon: ShieldAlert },
  { label: "Registre", icon: BookText },
  { label: "Obligations", icon: Scale },
  { label: "Modèles", icon: FileText },
  { label: "Moniteurs", icon: Monitor },
];

function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <ShieldAlert className="size-4.5" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">IncidentOps</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
        {NAV.map(({ label, icon: Icon, active }) => (
          <button
            key={label}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-3 border-t border-sidebar-border p-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
          WB
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Wael Ben Slima</p>
          <p className="truncate text-xs text-muted-foreground">Coordinateur</p>
        </div>
      </div>
    </aside>
  );
}

type Props = {
  title: string;
  company: string;
  severity: Severity;
  live: boolean;
  children: React.ReactNode;
};

export function AppShell({ title, company, severity, live, children }: Props) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-5 backdrop-blur">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{title}</h1>
              <Badge className={cn("hidden text-[11px] sm:inline-flex", SEVERITY_TONE[severity])}>
                {SEVERITY_LABEL[severity]}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">{company}</p>
          </div>
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
              live ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground",
            )}
          >
            <Activity className="size-3.5" />
            {live ? "Temps réel" : "Démo"}
          </span>
        </header>

        <main className="flex-1 bg-background">{children}</main>
      </div>
    </div>
  );
}
