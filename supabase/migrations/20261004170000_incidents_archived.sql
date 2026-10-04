-- Hide old test incidents from the site's list without deleting anything (the event log stays append-only).
-- An archived incident is still reachable by its URL.
alter table incidents add column archived_at timestamptz;
