"use client";

// Browser anon client for the dashboard's read + Realtime path (PLAN.md §2, R04:
// anon read is demo-only, synthetic data only). Returns null when env is absent,
// so the dashboard falls back to fixtures and still renders for the demo.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function getSupabaseBrowser(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  cached = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return cached;
}
