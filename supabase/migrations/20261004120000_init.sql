-- Incidents: one row per incident, facts merged in jsonb (lib/facts.ts is the schema).
create table incidents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  first_signal_at timestamptz not null,   -- first message seen (provisional clock start)
  awareness_at timestamptz,               -- confirmed by the coordinator (legal clock start)
  brief jsonb,
  facts jsonb not null default '{}'::jsonb,
  decision jsonb
);

-- Append-only audit trail = breach register (GDPR Art. 33(5)): who knew what, when.
create table incident_events (
  id bigint generated always as identity primary key,
  incident_id uuid not null references incidents(id),
  at timestamptz not null default now(),
  actor text not null,
  type text not null,                     -- signal | answer | awareness | decision | draft
  payload jsonb not null default '{}'::jsonb
);

-- ponytail: anon read for the demo (auth is mocked); real per-org RLS is in TODOS.md.
alter table incidents enable row level security;
alter table incident_events enable row level security;
create policy demo_read on incidents for select to anon using (true);
create policy demo_read on incident_events for select to anon using (true);

alter publication supabase_realtime add table incidents, incident_events;
