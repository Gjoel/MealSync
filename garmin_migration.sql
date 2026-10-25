-- ============================================================
-- Meal Sync: Garmin link (Garmin Connect Personal API)
-- One row per Meal Sync user who has linked Garmin. Holds the
-- user's Personal API key and the current 24-hour token.
-- Only the `garmin` edge function (service role) can read it.
-- ============================================================

create table if not exists cc_garmin (
  handle       text primary key references cc_users(handle)
               on delete cascade on update cascade,
  api_key      text not null,
  access_token text,
  token_exp    bigint,
  connected_at timestamptz not null default now(),
  skipped      jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

alter table cc_garmin enable row level security;
revoke all on cc_garmin from anon, authenticated;
grant all on cc_garmin to service_role;

-- Rollback, if ever needed:
-- drop table if exists cc_garmin;
