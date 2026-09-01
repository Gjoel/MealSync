-- ============================================================
-- Calorie Counter: sync + competition schema
-- Run once in the Supabase SQL editor (or let Claude apply it).
-- Everything is namespaced cc_ so it cannot collide with any
-- existing tables in the project.
--
-- Security model: RLS is enabled with NO policies, so the anon
-- key cannot touch the tables directly. All access goes through
-- SECURITY DEFINER functions that require the caller's secret
-- sync code. The leaderboard function is the only open read,
-- and it exposes exactly what competitors agree to share:
-- daily kcal, protein, burn, goal and whether the day was logged.
-- Weights and the full food log are only reachable with the
-- owner's secret.
-- ============================================================

create table if not exists cc_users (
  handle     text primary key check (handle ~ '^[a-z0-9_]{3,16}$'),
  secret     uuid not null unique,
  created_at timestamptz not null default now()
);

create table if not exists cc_state (
  secret     uuid not null,
  kind       text not null check (kind in ('log','exercise','weights','favs','profile')),
  data       jsonb not null,
  updated_at timestamptz not null,
  primary key (secret, kind)
);

create table if not exists cc_days (
  handle     text not null references cc_users(handle)
             on delete cascade on update cascade,
  day        date not null,
  kcal       integer not null default 0,
  protein    integer not null default 0,
  burned     integer not null default 0,
  goal       integer not null default 0,
  logged     boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (handle, day)
);

-- Lock the tables away from direct API access.
alter table cc_users enable row level security;
alter table cc_state enable row level security;
alter table cc_days  enable row level security;
revoke all on cc_users, cc_state, cc_days from anon, authenticated;

-- ------------------------------------------------------------
-- Register (or re-register / rename) a handle.
-- Returns 'ok' or 'taken'.
-- ------------------------------------------------------------
create or replace function cc_register(p_handle text, p_secret uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_handle !~ '^[a-z0-9_]{3,16}$' then
    raise exception 'invalid handle';
  end if;

  -- already registered exactly like this
  if exists (select 1 from cc_users where handle = p_handle and secret = p_secret) then
    return 'ok';
  end if;

  -- someone else owns the handle
  if exists (select 1 from cc_users where handle = p_handle) then
    return 'taken';
  end if;

  -- this secret already has a different handle: rename it
  if exists (select 1 from cc_users where secret = p_secret) then
    update cc_users set handle = p_handle where secret = p_secret;
    return 'ok';
  end if;

  insert into cc_users (handle, secret) values (p_handle, p_secret);
  return 'ok';
end;
$$;

-- ------------------------------------------------------------
-- Push one kind of device state (whole blob, newest wins).
-- ------------------------------------------------------------
create or replace function cc_push_state(
  p_secret uuid, p_kind text, p_data jsonb, p_updated timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from cc_users where secret = p_secret) then
    raise exception 'unregistered';
  end if;
  insert into cc_state (secret, kind, data, updated_at)
  values (p_secret, p_kind, p_data, p_updated)
  on conflict (secret, kind)
  do update set data = excluded.data, updated_at = excluded.updated_at;
end;
$$;

-- ------------------------------------------------------------
-- Pull all state blobs for a secret.
-- ------------------------------------------------------------
create or replace function cc_pull_state(p_secret uuid)
returns table (kind text, data jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from cc_users where secret = p_secret) then
    raise exception 'unregistered';
  end if;
  return query
    select s.kind, s.data, s.updated_at
    from cc_state s
    where s.secret = p_secret;
end;
$$;

-- ------------------------------------------------------------
-- Upsert daily summaries for the leaderboard.
-- p_days: [{"day":"2026-08-31","kcal":2100,"protein":150,
--           "burned":400,"goal":2200,"logged":true}, ...]
-- ------------------------------------------------------------
create or replace function cc_push_days(p_secret uuid, p_days jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_handle text;
begin
  select handle into v_handle from cc_users where secret = p_secret;
  if v_handle is null then
    raise exception 'unregistered';
  end if;
  insert into cc_days (handle, day, kcal, protein, burned, goal, logged, updated_at)
  select v_handle, x.day, coalesce(x.kcal,0), coalesce(x.protein,0),
         coalesce(x.burned,0), coalesce(x.goal,0), coalesce(x.logged,false), now()
  from jsonb_to_recordset(p_days)
    as x(day date, kcal int, protein int, burned int, goal int, logged boolean)
  on conflict (handle, day)
  do update set kcal = excluded.kcal, protein = excluded.protein,
                burned = excluded.burned, goal = excluded.goal,
                logged = excluded.logged, updated_at = now();
end;
$$;

-- ------------------------------------------------------------
-- The shared leaderboard feed: raw daily rows from p_from onward.
-- Everyone in the competition can read everyone's rows;
-- that is the point of the competition.
-- ------------------------------------------------------------
create or replace function cc_leaderboard(p_from date)
returns table (handle text, day date, kcal int, protein int,
               burned int, goal int, logged boolean)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select d.handle, d.day, d.kcal, d.protein, d.burned, d.goal, d.logged
  from cc_days d
  where d.day >= p_from;
$$;

-- Only the anon role may call these, and nothing else.
revoke execute on function cc_register(text, uuid) from public;
revoke execute on function cc_push_state(uuid, text, jsonb, timestamptz) from public;
revoke execute on function cc_pull_state(uuid) from public;
revoke execute on function cc_push_days(uuid, jsonb) from public;
revoke execute on function cc_leaderboard(date) from public;
grant execute on function cc_register(text, uuid) to anon;
grant execute on function cc_push_state(uuid, text, jsonb, timestamptz) to anon;
grant execute on function cc_pull_state(uuid) to anon;
grant execute on function cc_push_days(uuid, jsonb) to anon;
grant execute on function cc_leaderboard(date) to anon;

-- ============================================================
-- Rollback, if ever needed:
-- drop function if exists cc_leaderboard(date);
-- drop function if exists cc_push_days(uuid, jsonb);
-- drop function if exists cc_pull_state(uuid);
-- drop function if exists cc_push_state(uuid, text, jsonb, timestamptz);
-- drop function if exists cc_register(text, uuid);
-- drop table if exists cc_days;
-- drop table if exists cc_state;
-- drop table if exists cc_users;
-- ============================================================
