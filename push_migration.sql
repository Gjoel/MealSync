-- Evening reminder push notifications. Applied 17 Nov 2026.
-- cc_push_cfg holds the VAPID key pair and the cron secret (one row, service role only).
-- The row itself is inserted by hand and is NOT kept in this repo.
create table if not exists cc_push_cfg (
  id int primary key default 1 check (id = 1),
  vapid_public text not null, vapid_private text not null, cron_secret text not null
);
alter table cc_push_cfg enable row level security;
revoke all on cc_push_cfg from anon, authenticated;

create table if not exists cc_push_subs (
  endpoint text primary key,
  handle text not null references cc_users(handle) on delete cascade,
  sub jsonb not null,
  hour int not null default 20 check (hour between 0 and 23),
  tz text not null default 'Australia/Sydney',
  last_sent date,
  created_at timestamptz not null default now()
);
alter table cc_push_subs enable row level security;
revoke all on cc_push_subs from anon, authenticated;
-- RPCs cc_push_sub(handle, pass, sub, hour, tz) and cc_push_unsub(handle, pass, endpoint):
-- security definer, passcode checked with crypt(), granted to anon only.

-- Hourly job (minute 1) that calls the "remind" edge function with the cron secret.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('mealsync-remind', '1 * * * *', $$
  select net.http_post(
    url := 'https://fbiqmfxxqgykpmnfggxj.supabase.co/functions/v1/remind',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-cron-secret', (select cron_secret from public.cc_push_cfg where id = 1)),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
$$);
