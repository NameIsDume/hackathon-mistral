-- record_event gains p_awareness_at: setting the awareness time happens in the same UPDATE as the version bump and the event (R05, R07).
-- A correction is a new `awareness` event; nothing restarts, the clock is recomputed from awareness_at.
drop function record_event(uuid, int, text, text, jsonb, text, jsonb);

create function record_event(
  p_incident uuid,
  p_expected_version int,
  p_actor text,
  p_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_facts jsonb default null,
  p_awareness_at timestamptz default null
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
         facts = coalesce(p_facts, facts),
         awareness_at = coalesce(p_awareness_at, awareness_at)
   where id = p_incident and version = p_expected_version
  returning version into v;
  if v is null then
    raise exception 'version conflict on incident %', p_incident using errcode = 'PT409';
  end if;

  insert into incident_events (incident_id, actor, type, payload, idempotency_key)
  values (p_incident, p_actor, p_type, p_payload, p_idempotency_key);
  return v;
end $$;

revoke execute on function record_event(uuid, int, text, text, jsonb, text, jsonb, timestamptz) from public, anon, authenticated;
