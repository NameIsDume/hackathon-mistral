-- Follow-up to PLAN.md decisions R04, R07, R10 and the Signal contract.

-- Signals: one row per provider message; a replay never creates a second row.
create table signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default 'demo',
  connector_id text not null,
  external_id text not null,
  incident_id uuid references incidents(id),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  actor text not null,
  content text not null check (char_length(content) <= 4000),
  source_ref jsonb not null default '{}'::jsonb,
  unique (workspace_id, connector_id, external_id)
);
alter table signals enable row level security;
create policy demo_read on signals for select to anon using (true);

-- R07: optimistic version + per-incident answer token (R04).
alter table incidents
  add column version int not null default 1,
  add column answer_token text not null default replace(gen_random_uuid()::text, '-', '');

-- R04: anon reads incidents for Realtime, but never the answer token.
revoke select on incidents from anon;
grant select (id, created_at, first_signal_at, awareness_at, brief, facts, decision, version) on incidents to anon;

-- R07: idempotency key on events.
alter table incident_events add column idempotency_key text unique;

-- R10: incident_events is append-only, service_role included (triggers are not bypassed).
create function forbid_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'incident_events is append-only';
end $$;
create trigger incident_events_no_update_delete before update or delete on incident_events
  for each row execute function forbid_event_mutation();
create trigger incident_events_no_truncate before truncate on incident_events
  for each statement execute function forbid_event_mutation();

-- R07: facts update + event in one transaction, with optimistic locking and idempotency.
-- Returns the new incident version; a replayed idempotency key returns the current version unchanged.
create function record_event(
  p_incident uuid,
  p_expected_version int,
  p_actor text,
  p_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_facts jsonb default null
) returns int language plpgsql as $$
declare
  v int;
begin
  if exists (select 1 from incident_events where idempotency_key = p_idempotency_key) then
    select version into v from incidents where id = p_incident;
    return v;
  end if;

  update incidents
     set version = version + 1,
         facts = coalesce(p_facts, facts)
   where id = p_incident and version = p_expected_version
  returning version into v;
  if v is null then
    raise exception 'version conflict on incident %', p_incident using errcode = '40001';
  end if;

  insert into incident_events (incident_id, actor, type, payload, idempotency_key)
  values (p_incident, p_actor, p_type, p_payload, p_idempotency_key);
  return v;
end $$;

-- Server-only: PostgREST would otherwise expose these as public RPCs.
revoke execute on function record_event(uuid, int, text, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke execute on function forbid_event_mutation() from public, anon, authenticated;
