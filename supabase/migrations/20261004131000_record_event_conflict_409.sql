-- 40001 makes PostgREST retry until gateway timeout; PT409 returns a clean HTTP 409.
create or replace function record_event(
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
    raise exception 'version conflict on incident %', p_incident using errcode = 'PT409';
  end if;

  insert into incident_events (incident_id, actor, type, payload, idempotency_key)
  values (p_incident, p_actor, p_type, p_payload, p_idempotency_key);
  return v;
end $$;
