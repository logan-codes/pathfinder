-- 0003 — onboarding, measured mastery, and unacknowledged path changes.
--
-- Three more documents on the same row, for the same reason as 0002: they
-- belong to one learner, they are read and written together, and nothing in
-- Postgres computes on them.
--
-- Written to stand on its own. It does not assume 0001 and 0002 have been
-- applied to this project — a table created by hand, a partial run, or a
-- project restored from a backup all end up somewhere between them, and a
-- migration that fails halfway on "column profile does not exist" leaves the
-- app unable to save anything. Every column the server reads is ensured here,
-- and every statement is re-runnable.
--
-- No new policies: the owner-only policies from 0001 are per-row, so they
-- already cover every column added here and every column added later.

-- ---------------------------------------------------------------------------
-- the table, and the columns the earlier migrations were meant to leave
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  -- From 0001. The LearnerProfile document from src/lib/types.ts.
  add column if not exists profile jsonb not null default '{}'::jsonb,
  -- From 0002. Per-resource progress, and the assistant transcript.
  add column if not exists progress jsonb not null default '{}'::jsonb,
  add column if not exists conversation jsonb not null default '[]'::jsonb,
  -- New here.
  add column if not exists mastery jsonb not null default '{}'::jsonb,
  add column if not exists marks jsonb not null default '{}'::jsonb,
  add column if not exists unverified jsonb not null default '{}'::jsonb;

-- Row-level security, in case this table predates 0001's policies. Each is
-- dropped first so re-running this file is not an error.
alter table public.profiles enable row level security;

drop policy if exists "profiles are readable by their owner" on public.profiles;
create policy "profiles are readable by their owner"
  on public.profiles for select using (auth.uid() = id);

drop policy if exists "profiles are insertable by their owner" on public.profiles;
create policy "profiles are insertable by their owner"
  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "profiles are updatable by their owner" on public.profiles;
create policy "profiles are updatable by their owner"
  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles are deletable by their owner" on public.profiles;
create policy "profiles are deletable by their owner"
  on public.profiles for delete using (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- observability
--
-- Cosmetic: these make the table legible in the dashboard without opening the
-- jsonb, and nothing in the app reads them. Defined here rather than assumed
-- from 0002, so this file does not depend on that one having run.
-- ---------------------------------------------------------------------------

create or replace function public.jsonb_object_size(value jsonb)
returns integer
language sql
immutable
parallel safe
as $$
  select case
    when value is null or jsonb_typeof(value) <> 'object' then 0
    else (select count(*)::integer from jsonb_object_keys(value))
  end
$$;

alter table public.profiles
  add column if not exists onboarded_at bigint
    generated always as (
      case when jsonb_typeof(profile -> 'onboardedAt') = 'number'
           then (profile ->> 'onboardedAt')::bigint
           else null end
    ) stored,

  add column if not exists avoid_count integer
    generated always as (
      case when jsonb_typeof(profile -> 'avoid') = 'array'
           then jsonb_array_length(profile -> 'avoid')
           else 0 end
    ) stored,

  add column if not exists verified_skill_count integer
    generated always as (public.jsonb_object_size(mastery)) stored,

  add column if not exists unseen_change_count integer
    generated always as (public.jsonb_object_size(marks)) stored;

comment on column public.profiles.mastery is
  'Per-skill posterior from graded checks. Replayed as the prior on the next round.';
comment on column public.profiles.unverified is
  'Items ticked while the server was unreachable, so nothing could be graded.';
comment on column public.profiles.marks is
  'Path additions and removals the learner has not clicked through yet.';

-- ---------------------------------------------------------------------------
-- a row per account
--
-- From 0001. Repeated because a project missing it has accounts with no
-- profile row at all, which the app reads as "brand new" on every sign-in.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'name', ''),
      split_part(coalesce(new.email, 'learner'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- From 0002. `auth.uid()` decides the row, so the only account anyone can
-- delete is their own, and the server needs no RLS-bypassing key to offer it.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
