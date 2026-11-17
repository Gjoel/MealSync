-- Shared meals inbox and new synced kinds (body, plan). Applied 17 Nov 2026.
create table if not exists cc_inbox (
  id uuid primary key default gen_random_uuid(),
  to_handle text not null references cc_users(handle) on delete cascade,
  from_handle text not null references cc_users(handle) on delete cascade,
  day date not null,
  meal jsonb not null,
  created_at timestamptz not null default now(),
  taken_at timestamptz
);
create index if not exists cc_inbox_to on cc_inbox (to_handle) where taken_at is null;
alter table cc_inbox enable row level security;
-- RPCs cc_share_meal(handle, pass, to, day, meal), cc_inbox_pull(handle, pass),
-- cc_inbox_take(handle, pass, id): security definer, check the passcode with crypt(),
-- granted to anon only. See the Supabase migration "cc_inbox_and_kinds" for full bodies.
alter table cc_state drop constraint if exists cc_state_kind_check;
alter table cc_state add constraint cc_state_kind_check
  check (kind in ('log','exercise','weights','favs','profile','foods','deleted','body','plan'));
