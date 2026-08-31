/**
 * Supabase: identity and the one piece of durable state this app has.
 *
 * Scope is deliberately narrow. Supabase owns **auth** (GoTrue) and the
 * **profiles** table; it does not own planning, grading, guardrails or the
 * model layer. Those stay in this Express process, deterministic and
 * offline-capable, which is the property the whole project is built on.
 *
 * Two clients, for two different jobs:
 *
 *   anon     Used for sign-up and sign-in, and as the base for a per-request
 *            client carrying the caller's access token. Every query made
 *            through it is subject to row-level security, so a bug in a
 *            route here cannot read another learner's row.
 *   service  Bypasses RLS, and is therefore used for nothing. It exists only
 *            because a future admin view would need it. Even account
 *            deletion goes through a SECURITY DEFINER function instead — see
 *            `deleteOwnAccount` — so this server can run with no
 *            RLS-bypassing credential in its environment at all.
 *
 * When the environment has no Supabase credentials the module reports itself
 * unavailable and the auth routes answer 503. The rest of the API is
 * untouched: planning, quizzes and the model edges all still work signed
 * out, because they never needed an account in the first place.
 */

import {
  createClient,
  type SupabaseClient,
  type User as SupabaseUser,
} from '@supabase/supabase-js'
import type { LearnerProfile } from '../src/lib/types.js'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './config.js'

export const PROFILES_TABLE = 'profiles'

/**
 * Sign-in needs a URL and an anon key, and that is the whole requirement.
 * The service-role key is optional and currently unused: everything a
 * learner can do, including deleting their account, runs under their own
 * session with RLS in force.
 */
export function supabaseEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
}

export function supabaseAdminEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
}

export class SupabaseUnavailableError extends Error {
  constructor() {
    super(
      'This server has no Supabase credentials, so accounts are turned off. Set SUPABASE_URL and SUPABASE_ANON_KEY to enable sign-in.',
    )
    this.name = 'SupabaseUnavailableError'
  }
}

/**
 * No session persistence and no auto-refresh: this is a server, and a shared
 * client that quietly remembered the last caller's session would be a
 * cross-request identity leak rather than a convenience.
 */
const SERVER_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const

let anonClient: SupabaseClient | null = null

/** The shared anonymous client. Sign-in and sign-up go through this. */
export function anon(): SupabaseClient {
  if (!supabaseEnabled()) throw new SupabaseUnavailableError()
  if (!anonClient) {
    anonClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { auth: SERVER_AUTH })
  }
  return anonClient
}

let serviceClient: SupabaseClient | null = null

/** Admin client. Only for operations that are meant to bypass RLS. */
export function service(): SupabaseClient {
  if (!supabaseAdminEnabled()) throw new SupabaseUnavailableError()
  if (!serviceClient) {
    serviceClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: SERVER_AUTH,
    })
  }
  return serviceClient
}

/**
 * A client that acts as one caller. The access token rides on every request,
 * so `auth.uid()` resolves inside Postgres and the RLS policies in
 * `supabase/migrations` do the actual authorisation.
 *
 * Not cached: the token is per-request, and caching a client keyed on a
 * credential is how identities get crossed.
 */
export function asUser(accessToken: string): SupabaseClient {
  if (!supabaseEnabled()) throw new SupabaseUnavailableError()
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: SERVER_AUTH,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

// ---- the signed-in caller ----------------------------------------------

/** What the rest of the server needs to know about who is asking. */
export interface Caller {
  id: string
  email: string
  /** From user metadata, falling back to the local part of the email. */
  name: string
  createdAt: number
  accessToken: string
}

export function callerFrom(user: SupabaseUser, accessToken: string): Caller {
  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
  const email = user.email ?? ''

  return {
    id: user.id,
    email,
    name: name || email.split('@')[0] || 'Learner',
    createdAt: user.created_at ? Date.parse(user.created_at) : Date.now(),
    accessToken,
  }
}

/** What a client is allowed to see. Never a token. */
export interface PublicUser {
  id: string
  email: string
  name: string
  createdAt: number
}

export function publicUser(caller: Caller): PublicUser {
  return {
    id: caller.id,
    email: caller.email,
    name: caller.name,
    createdAt: caller.createdAt,
  }
}

/**
 * Verify an access token and resolve its owner. Returns null for anything
 * that is not a live session — expired, revoked, or never valid. The caller
 * decides whether that is worth a refresh attempt.
 */
export async function resolveAccessToken(accessToken: string): Promise<Caller | null> {
  if (!supabaseEnabled()) return null

  try {
    const { data, error } = await anon().auth.getUser(accessToken)
    if (error || !data.user) return null
    return callerFrom(data.user, accessToken)
  } catch {
    // A network failure to Supabase is not an authentication decision, but
    // from the caller's side it is indistinguishable, and treating it as
    // "signed out" is the safe direction.
    return null
  }
}

export interface RefreshedSession {
  caller: Caller
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Exchange a refresh token for a new access token. */
export async function refreshSession(refreshToken: string): Promise<RefreshedSession | null> {
  if (!supabaseEnabled()) return null

  try {
    const { data, error } = await anon().auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session || !data.user) return null

    return {
      caller: callerFrom(data.user, data.session.access_token),
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: (data.session.expires_at ?? 0) * 1000,
    }
  } catch {
    return null
  }
}

// ---- the profiles table -------------------------------------------------

/**
 * Everything about a learner that survives a browser.
 *
 * Three parts, because they have three different lifetimes: the profile is
 * what the learner asserts, the progress is what they have done, and the
 * conversation is how they got there. The engine reads only the first, which
 * is why it is the only one the schema validates strictly.
 */
export interface LearnerState {
  profile: LearnerProfile | null
  /** Record<ResourceId, 'todo' | 'active' | 'done'>. */
  progress: Record<string, string>
  /** Assistant transcript, newest last. */
  conversation: unknown[]
}

export const EMPTY_STATE: LearnerState = { profile: null, progress: {}, conversation: [] }

/**
 * A transcript is the one thing here that grows without bound, so it is
 * trimmed to the most recent slice on the way in. Old turns are not worth a
 * row that keeps getting bigger for the rest of the account's life.
 */
const MAX_CONVERSATION = 200

/**
 * Read the caller's whole saved state.
 *
 * Read through a user-scoped client rather than the service key, so the RLS
 * policy is doing the authorisation and this function cannot be talked into
 * returning somebody else's row.
 */
export async function readState(caller: Caller): Promise<LearnerState> {
  const { data, error } = await asUser(caller.accessToken)
    .from(PROFILES_TABLE)
    .select('profile, progress, conversation')
    .eq('id', caller.id)
    .maybeSingle()

  if (error) throw new Error(`could not read profile: ${error.message}`)
  if (!data) return EMPTY_STATE

  // A row created by the signup trigger has `{}` for its profile, which is
  // not a LearnerProfile — it is the absence of one, and the client needs to
  // tell those apart to know whether to adopt or to push.
  const profile = data.profile as LearnerProfile | null
  const hasProfile = profile && typeof profile === 'object' && Object.keys(profile).length > 0

  return {
    profile: hasProfile ? profile : null,
    progress: (data.progress as Record<string, string>) ?? {},
    conversation: Array.isArray(data.conversation) ? data.conversation : [],
  }
}

/**
 * Write it back. Upsert rather than update: the trigger in the migration
 * creates a row on sign-up, but a project restored from a backup, or a user
 * created straight in the dashboard, may not have one.
 *
 * The generated columns in migration 0002 — goal_id, pace, completed_count
 * and the rest — are derived by Postgres from `profile` on this write. They
 * are never set here, so they cannot drift from the document.
 */
export async function writeState(caller: Caller, state: LearnerState): Promise<void> {
  const conversation = state.conversation.slice(-MAX_CONVERSATION)

  const { error } = await asUser(caller.accessToken)
    .from(PROFILES_TABLE)
    .upsert(
      {
        id: caller.id,
        display_name: state.profile?.name ?? caller.name,
        profile: state.profile ?? {},
        progress: state.progress,
        conversation,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )

  if (error) throw new Error(`could not save profile: ${error.message}`)
}

/**
 * Delete the caller's account and everything cascading from it.
 *
 * Goes through the `delete_own_account()` function in migration 0002 rather
 * than the admin API, so this works on a server that holds no service-role
 * key. `auth.uid()` inside the function decides the row, which means the
 * only account anyone can delete is their own — the route is not trusted to
 * pass the right id, because the route never passes one.
 */
export async function deleteOwnAccount(caller: Caller): Promise<void> {
  const { error } = await asUser(caller.accessToken).rpc('delete_own_account')
  if (!error) return

  // A project that has 0001 applied but not 0002 has no such function. Say
  // so, rather than reporting a generic failure the operator cannot act on.
  if (/could not find the function|does not exist|PGRST202/i.test(error.message)) {
    throw new Error(
      'delete_own_account() is missing — run supabase/migrations/0002_learner_state.sql',
    )
  }
  throw new Error(error.message)
}
