-- Pathfinder: the one table this project keeps.
--
-- Supabase owns identity (auth.users, managed by GoTrue) and this table.
-- Everything else — the catalogue, the engine, the quiz bank, the guardrails
-- — stays in the Express server and in version control, because it is code
-- and committed data rather than user state.
--
-- Run against a hosted project with either:
--   supabase db push                 (with the project linked)
--   or paste this file into the SQL editor in the dashboard
--
-- It is written to be re-runnable: every object is created if-not-exists or
-- dropped first, so applying it twice is not an error.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  -- Same id as the auth user, and gone when they are. No orphan rows, and no
  -- second identifier to keep in step.
  id uuid primary key references auth.users (id) on delete cascade,

  -- Denormalised out of the JSON so the dashboard is readable and so a
  -- future "find learners by name" does not need a jsonb scan.
  display_name text not null default '',

  -- The LearnerProfile from src/lib/types.ts. Kept as jsonb rather than
  -- exploded into columns on purpose: it is a document the client owns and
  -- the engine reads whole, it is validated by ProfileSchema on the way in,
  -- and adding a field to it should not need a migration.
  profile jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One learner profile per account. Validated server-side by ProfileSchema before it lands here.';

-- ---------------------------------------------------------------------------
-- row-level security
--
-- The server reads and writes this table through a client carrying the
-- caller's access token, so auth.uid() resolves here and these policies are
-- the actual authorisation. A bug in a route cannot read another learner's
-- row, because the route is not what decides.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

drop policy if exists "profiles are readable by their owner" on public.profiles;
create policy "profiles are readable by their owner"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles are insertable by their owner" on public.profiles;
create policy "profiles are insertable by their owner"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles are updatable by their owner" on public.profiles;
create policy "profiles are updatable by their owner"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "profiles are deletable by their owner" on public.profiles;
create policy "profiles are deletable by their owner"
  on public.profiles for delete
  using (auth.uid() = id);

-- No policy grants access to anyone else's row, and RLS denies by default,
-- so there is deliberately nothing here for "any authenticated user".

-- ---------------------------------------------------------------------------
-- keep updated_at honest
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- a profile row for every new account
--
-- The server upserts anyway, so this is not load-bearing — but without it the
-- first read after sign-up returns nothing, and "your profile is empty
-- because nobody has written one yet" is a state worth not having.
--
-- SECURITY DEFINER because the trigger runs as the inserting role, which for
-- a sign-up is not the new user and therefore fails its own RLS policy.
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
