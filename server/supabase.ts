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
 *   service  Bypasses RLS. Used for exactly one thing — deleting a user from
 *            auth.users, which is an admin operation by definition. It is
 *            never used to read or write profile data.
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
import type { LearnerProfile } from '../src/lib/types'
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from './config'

export const PROFILES_TABLE = 'profiles'

/**
 * Sign-in needs a URL and an anon key. The service role key is optional —
 * without it everything works except closing an account, which is the one
 * operation that has to reach past RLS.
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
 * Read the caller's saved learner profile.
 *
 * Read through a user-scoped client rather than the service key, so the RLS
 * policy is doing the authorisation and this function cannot be talked into
 * returning somebody else's row.
 */
export async function readProfile(caller: Caller): Promise<unknown | null> {
  const { data, error } = await asUser(caller.accessToken)
    .from(PROFILES_TABLE)
    .select('profile')
    .eq('id', caller.id)
    .maybeSingle()

  if (error) throw new Error(`could not read profile: ${error.message}`)
  return (data?.profile as unknown) ?? null
}

/**
 * Write it back. Upsert rather than update: the trigger in the migration
 * creates a row on sign-up, but a project restored from a backup, or a user
 * created straight in the dashboard, may not have one.
 */
export async function writeProfile(caller: Caller, profile: LearnerProfile): Promise<void> {
  const { error } = await asUser(caller.accessToken)
    .from(PROFILES_TABLE)
    .upsert(
      {
        id: caller.id,
        display_name: profile.name,
        profile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )

  if (error) throw new Error(`could not save profile: ${error.message}`)
}
