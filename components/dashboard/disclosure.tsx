"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

// Minimal show/hide for secondary content: keeps the default view calm while the
// full journal / advanced detail stay one click away.
export function Disclosure({ label, count, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-4 text-left text-sm font-semibold"
      >
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        {label}
        {count != null && count > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{count}</span>
        )}
      </button>
      {open && <div className="border-t border-border p-5">{children}</div>}
    </section>
  );
}
