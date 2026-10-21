-- ============================================================
-- Meal Sync: Strava link
-- One row per Meal Sync user who has connected Strava.
-- Only the `strava` edge function (service role) can read it;
-- the anon key the app ships with cannot touch it at all.
-- ============================================================

create table if not exists cc_strava (
  handle        text primary key references cc_users(handle)
                on delete cascade on update cascade,
  athlete_id    bigint,
  athlete_name  text,
  access_token  text,
  refresh_token text,
  expires_at    bigint,
  pending_state text,
  pending_at    timestamptz,
  connected_at  timestamptz,
  skipped       jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

create index if not exists cc_strava_pending_idx on cc_strava (pending_state);

alter table cc_strava enable row level security;
revoke all on cc_strava from anon, authenticated;
grant all on cc_strava to service_role;

-- Rollback, if ever needed:
-- drop table if exists cc_strava;
