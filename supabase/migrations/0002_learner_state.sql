-- Pathfinder: the whole learner, not just their name.
--
-- 0001 stored the LearnerProfile as one jsonb document, which was right — it
-- is a document the client owns and the engine reads whole. Two problems
-- with where that left things:
--
--   1. Only `display_name` was its own column, so the dashboard showed a list
--      of names and nothing else. Everything was stored; nothing was legible.
--   2. Two pieces of learner state were never persisted at all. Per-resource
--      progress and the assistant conversation lived in localStorage only, so
--      signing in on a second browser restored your goal and your skill
--      levels but not what you had actually done.
--
-- This migration fixes both, and adds the function that lets someone delete
-- their own account without the server holding a service-role key.
--
-- Re-runnable, like 0001.

-- ---------------------------------------------------------------------------
-- the state that was missing
-- ---------------------------------------------------------------------------

alter table public.profiles
  -- Record<ResourceId, 'todo' | 'active' | 'done'>. What the learner has
  -- actually started and finished, as opposed to what they told us they had
  -- completed before they arrived (which is profile -> 'completed').
  add column if not exists progress jsonb not null default '{}'::jsonb,

  -- The assistant transcript. Capped server-side, because a conversation is
  -- the one thing here that grows without bound.
  add column if not exists conversation jsonb not null default '[]'::jsonb;

comment on column public.profiles.progress is
  'Per-resource status. Distinct from profile->completed, which is prior history the learner declared.';
comment on column public.profiles.conversation is
  'Assistant transcript, most recent messages only. Trimmed by the server before it lands.';

-- ---------------------------------------------------------------------------
-- make the document legible
--
-- Generated columns rather than triggers or application writes: they are
-- derived by Postgres from the jsonb on every write, so they cannot drift
-- from the document the way a denormalised copy eventually does. They exist
-- for the dashboard and for aggregate queries — the engine still reads the
-- whole document and never these.
--
-- Each expression is guarded on jsonb_typeof, because a generated column that
-- can raise turns a bad write into a failed insert rather than a bad row.
-- ---------------------------------------------------------------------------

-- Counting the keys of a jsonb object needs jsonb_object_keys(), which is
-- set-returning — so counting it means a subquery, and Postgres rejects a
-- subquery inside a generated column expression (SQLSTATE 0A000).
--
-- A generated column may still *call* a function, so the subquery moves in
-- here. IMMUTABLE is the part that makes it eligible: same input, same
-- output, forever, which is what lets Postgres store the result.
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

comment on function public.jsonb_object_size(jsonb) is
  'Key count of a jsonb object, 0 for anything else. Immutable so generated columns can use it.';

alter table public.profiles
  add column if not exists goal_id text
    generated always as (profile ->> 'goalId') stored,

  add column if not exists experience text
    generated always as (profile ->> 'experience') stored,

  add column if not exists pace text
    generated always as (profile ->> 'pace') stored,

  add column if not exists goal_statement text
    generated always as (profile ->> 'goalStatement') stored,

  add column if not exists completed_count integer
    generated always as (
      case when jsonb_typeof(profile -> 'completed') = 'array'
           then jsonb_array_length(profile -> 'completed')
           else 0 end
    ) stored,

  add column if not exists interest_count integer
    generated always as (
      case when jsonb_typeof(profile -> 'interests') = 'array'
           then jsonb_array_length(profile -> 'interests')
           else 0 end
    ) stored,

  add column if not exists rated_skill_count integer
    generated always as (public.jsonb_object_size(profile -> 'selfRated')) stored;

-- "How many learners are on each track" is the first question anyone asks of
-- this table, and the only one worth an index at this size.
create index if not exists profiles_goal_id_idx on public.profiles (goal_id);

-- ---------------------------------------------------------------------------
-- deleting your own account
--
-- A user cannot delete themselves out of auth.users: it is not their table
-- and no policy could sensibly grant it. The usual answer is to give the
-- server a service-role key and call the admin API — but that means the
-- process holds a credential that bypasses RLS on everything, forever, to
-- support one button.
--
-- This is the smaller hammer. SECURITY DEFINER runs the delete as the
-- function's owner, and `auth.uid()` still resolves to the caller, so the
-- only row anyone can ever delete is their own. The profile row follows via
-- the ON DELETE CASCADE in 0001.
--
-- EXECUTE is granted to `authenticated` only. Without the revoke, PUBLIC gets
-- execute by default and an anonymous caller could reach it — where
-- auth.uid() is null, so it would delete nothing, but a function that
-- deletes users should not be callable by people who are not users.
-- ---------------------------------------------------------------------------

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

comment on function public.delete_own_account() is
  'Deletes the calling user and cascades their profile. Self-service only: auth.uid() decides the row.';
