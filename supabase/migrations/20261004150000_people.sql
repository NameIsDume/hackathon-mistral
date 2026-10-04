-- Org chart for Slack DM routing (#25): role -> person -> Slack user. Server-only (service role), no anon policy.
create table people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('reporter', 'it', 'business_owner', 'dpo', 'lawyer', 'management', 'communications')),
  email text not null,
  slack_user_id text unique
);
alter table people enable row level security;
revoke all on people from anon, authenticated;
