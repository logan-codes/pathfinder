/**
 * Sign up, sign in, sign out — Supabase Auth behind an Express façade.
 *
 * The façade earns its place. It keeps tokens in httpOnly cookies instead of
 * localStorage, which is where the browser SDK would put them and where any
 * injected script could read them. It gives the client one origin and one
 * error envelope. And it means the front end has no Supabase credentials in
 * its bundle at all — the anon key is safe to publish, but not shipping it
 * is still strictly better than shipping it.
 *
 * Failures are deliberately uninformative: Supabase already answers "Invalid
 * login credentials" for both an unknown address and a wrong password, and
 * that is passed through rather than improved upon.
 *
 * With no Supabase credentials configured every route here answers 503 and
 * the rest of the API carries on. Accounts are an upgrade, not a dependency.
 */

import { Router } from 'express'
import { ALLOW_REGISTRATION, AUTH_REDIRECT_URL } from '../config'
import {
  asyncHandler,
  clearSessionCookies,
  HttpError,
  parseBody,
  requireUser,
  setSessionCookies,
} from '../http'
import {
  AccountPatchRequest,
  LoginRequest,
  PasswordChangeRequest,
  RegisterRequest,
  StateSaveRequest,
} from '../schema'
import {
  anon,
  asUser,
  callerFrom,
  deleteOwnAccount,
  EMPTY_STATE,
  publicUser,
  readState,
  supabaseEnabled,
  writeState,
} from '../supabase'

export const authRouter = Router()

/** Every route in this file needs Supabase; none of the others do. */
function assertAvailable(): void {
  if (!supabaseEnabled()) {
    throw new HttpError(
      503,
      'auth_unavailable',
      'Accounts are turned off on this server. Everything else works signed out.',
    )
  }
}

/**
 * Supabase error messages are mostly already written for people, so this maps
 * the few cases where the status matters and passes the rest through.
 *
 * The exception is transport failure. A wrong SUPABASE_URL, a dropped
 * network or a project that has been paused all surface as Node's "fetch
 * failed", which tells a learner nothing and tells an operator nothing about
 * where to look. Those become a 503 that says which of the two it is.
 */
function authError(message: string, status = 401): HttpError {
  const lowered = message.toLowerCase()

  if (
    lowered.includes('fetch failed') ||
    lowered.includes('failed to fetch') ||
    lowered.includes('enotfound') ||
    lowered.includes('econnrefused') ||
    lowered.includes('etimedout') ||
    lowered.includes('network')
  ) {
    return new HttpError(
      503,
      'auth_unreachable',
      'Could not reach the identity service. Check SUPABASE_URL and that the project is running — everything else in the app still works signed out.',
    )
  }

  if (lowered.includes('already registered') || lowered.includes('already exists')) {
    return new HttpError(409, 'email_taken', 'An account with that email already exists.')
  }
  if (lowered.includes('not confirmed')) {
    return new HttpError(
      403,
      'email_not_confirmed',
      'Confirm your email address first — check your inbox for the link.',
    )
  }
  if (lowered.includes('invalid api key') || lowered.includes('jwt')) {
    return new HttpError(
      503,
      'auth_misconfigured',
      'The server’s Supabase key was rejected. Check SUPABASE_ANON_KEY.',
    )
  }

  return new HttpError(status, 'invalid_credentials', message)
}

authRouter.post(
  '/auth/register',
  asyncHandler(async (req, res) => {
    assertAvailable()
    if (!ALLOW_REGISTRATION) {
      throw new HttpError(403, 'registration_closed', 'This server is not accepting new accounts.')
    }

    const { email, password, name } = parseBody(RegisterRequest, req.body)

    const { data, error } = await anon().auth.signUp({
      email,
      password,
      options: { data: { name }, emailRedirectTo: AUTH_REDIRECT_URL },
    })

    if (error) throw authError(error.message, 400)

    // A project with email confirmation switched on returns a user and no
    // session. That is a success, not a failure — the client shows "check
    // your inbox" rather than pretending the sign-up did not happen.
    if (!data.session || !data.user) {
      res.status(202).json({
        user: null,
        pendingConfirmation: true,
        message: 'Account created. Confirm your email address, then sign in.',
        ...EMPTY_STATE,
      })
      return
    }

    setSessionCookies(res, {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    })

    // A new account has nothing stored yet by definition, so the empty state
    // goes back rather than a read — and the client knows to push whatever it
    // already has on screen up to the new row.
    res.status(201).json({
      user: publicUser(callerFrom(data.user, data.session.access_token)),
      pendingConfirmation: false,
      expiresAt: (data.session.expires_at ?? 0) * 1000,
      ...EMPTY_STATE,
    })
  }),
)

authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    assertAvailable()
    const { email, password } = parseBody(LoginRequest, req.body)

    const { data, error } = await anon().auth.signInWithPassword({ email, password })
    if (error || !data.session || !data.user) {
      throw authError(error?.message ?? 'That email or password is not right.')
    }

    const caller = callerFrom(data.user, data.session.access_token)
    setSessionCookies(res, {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    })

    // Handed back with the session so the client can adopt it in one round
    // trip instead of signing in and then asking what it just signed into.
    let state = EMPTY_STATE
    try {
      state = await readState(caller)
    } catch {
      // A readable session with an unreadable profile is still a sign-in.
    }

    res.json({
      user: publicUser(caller),
      pendingConfirmation: false,
      expiresAt: (data.session.expires_at ?? 0) * 1000,
      ...state,
    })
  }),
)

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    // Revoke server-side so the refresh token is dead everywhere, not just
    // forgotten by this browser.
    if (req.user && supabaseEnabled()) {
      try {
        await asUser(req.user.accessToken).auth.signOut()
      } catch {
        // Already invalid, or Supabase is unreachable. The cookies still go.
      }
    }
    clearSessionCookies(res)
    res.json({ ok: true })
  }),
)

/**
 * Who am I? Answers 200 with `user: null` rather than 401 when nobody is
 * signed in — "not signed in" is a normal state in this app, and the client
 * boots by asking this question.
 */
authRouter.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    let state = EMPTY_STATE
    if (req.user) {
      try {
        state = await readState(req.user)
      } catch {
        // Signed in with an unreadable row is still signed in.
      }
    }

    res.json({
      user: req.user ? publicUser(req.user) : null,
      ...state,
      /** Lets the UI hide sign-in entirely rather than offer a broken form. */
      available: supabaseEnabled(),
      registrationOpen: ALLOW_REGISTRATION,
      /**
       * Deletion runs through a SECURITY DEFINER function rather than the
       * admin API, so it needs a session and migration 0002 — not a
       * service-role key. Kept in the payload because the UI still has to
       * know whether to offer the button.
       */
      canDeleteAccount: supabaseEnabled(),
    })
  }),
)

authRouter.patch(
  '/auth/me',
  requireUser,
  asyncHandler(async (req, res) => {
    const patch = parseBody(AccountPatchRequest, req.body)

    const { data, error } = await asUser(req.user!.accessToken).auth.updateUser({
      ...(patch.email ? { email: patch.email } : {}),
      ...(patch.name ? { data: { name: patch.name } } : {}),
    })

    if (error || !data.user) throw authError(error?.message ?? 'Could not update the account.', 400)

    res.json({
      user: publicUser(callerFrom(data.user, req.user!.accessToken)),
      // Changing an email sends a confirmation to the new address; until it
      // is clicked, the old one is still the account's address.
      emailPending: Boolean(patch.email && data.user.new_email),
    })
  }),
)

authRouter.post(
  '/auth/password',
  requireUser,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parseBody(PasswordChangeRequest, req.body)

    // `updateUser` does not ask for the current password, so a stolen session
    // could otherwise change it and lock the owner out. Re-authenticate first.
    const { error: reauth } = await anon().auth.signInWithPassword({
      email: req.user!.email,
      password: currentPassword,
    })
    if (reauth) {
      throw new HttpError(403, 'wrong_password', 'That is not your current password.')
    }

    const { error } = await asUser(req.user!.accessToken).auth.updateUser({
      password: newPassword,
    })
    if (error) throw authError(error.message, 400)

    clearSessionCookies(res)
    res.json({ ok: true, signedOutEverywhere: true })
  }),
)

authRouter.post(
  '/auth/logout-all',
  requireUser,
  asyncHandler(async (req, res) => {
    try {
      await asUser(req.user!.accessToken).auth.signOut({ scope: 'global' })
    } catch {
      // Best effort; the cookies go regardless.
    }
    clearSessionCookies(res)
    res.json({ ok: true })
  }),
)

/**
 * Close the account.
 *
 * Goes through the `delete_own_account()` function from migration 0002,
 * which runs SECURITY DEFINER and resolves the row from `auth.uid()`. Two
 * things follow from that: it needs no service-role key, and this route
 * never names a user id — so no bug here can delete the wrong account.
 *
 * The profile row, with the progress and the conversation in it, goes with
 * the user by the cascade in migration 0001.
 */
authRouter.delete(
  '/auth/me',
  requireUser,
  asyncHandler(async (req, res) => {
    try {
      await deleteOwnAccount(req.user!)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (message.includes('0002_learner_state.sql')) {
        throw new HttpError(501, 'delete_unavailable', message)
      }
      throw new HttpError(500, 'delete_failed', message)
    }

    clearSessionCookies(res)
    res.json({ ok: true })
  }),
)

// ---- the saved learner state --------------------------------------------

/**
 * What an account buys: the same learner in two browsers. Not just their
 * name — the goal, the pace, the interests, the self-rated skills, the prior
 * history, the per-resource progress, and the conversation that produced all
 * of it.
 *
 * Every planning route is still stateless and still works signed out. This
 * is the only durable state in the product.
 *
 * Both routes go through a client carrying the caller's access token, so the
 * RLS policies in `supabase/migrations` are the actual authorisation.
 */
authRouter.get(
  '/me/state',
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await readState(req.user!))
  }),
)

authRouter.put(
  '/me/state',
  requireUser,
  asyncHandler(async (req, res) => {
    // `profile` is validated with the same schema every planning route uses,
    // so stored state can never be a shape the engine has not seen — and so
    // the guardrail transforms in ProfileSchema (normalisation, PII
    // redaction) run before anything is persisted.
    const state = parseBody(StateSaveRequest, req.body)
    await writeState(req.user!, state)
    res.json({ ...state, savedAt: Date.now() })
  }),
)
