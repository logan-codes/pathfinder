/**
 * Who is signed in, and what that changes.
 *
 * Signing in is optional. The app has always worked with the server stopped,
 * and it still does — an account buys you one profile across two browsers,
 * not permission to use the product. So this store is deliberately small and
 * deliberately unable to block anything: `status` starts at `unknown`, and
 * every screen renders regardless of what it settles on.
 *
 * The sync policy, which is the only interesting decision here:
 *
 *   sign in, server has a profile   the server's profile wins and replaces
 *                                   the local one — you came back to your
 *                                   account to find your work
 *   sign in, server has none        the local profile is pushed up, so a
 *                                   first sign-in adopts whatever you were
 *                                   already doing instead of resetting it
 *   signed in, profile edited       debounced PUT, same coalescing reason as
 *                                   the path rebuild
 *   sign out                        local state is left exactly as it is.
 *                                   Wiping someone's work to "clean up" is a
 *                                   bug wearing a feature's clothes
 */

import { create } from 'zustand'
import {
  ApiError,
  deleteAccount as apiDeleteAccount,
  getAuthMe,
  patchAccount,
  postLogin,
  postLogout,
  postLogoutAll,
  postPasswordChange,
  postRegister,
  putSavedProfile,
  type AccountUser,
} from '@/lib/api'
import type { LearnerProfile } from '@/lib/types'
import { useAppStore } from './useAppStore'

export type AuthStatus = 'unknown' | 'signed-out' | 'signed-in'

/** A profile edit is not worth a request per keystroke. */
const SAVE_DEBOUNCE_MS = 800
const AUTH_TIMEOUT_MS = 15000

interface AuthState {
  status: AuthStatus
  user: AccountUser | null
  /**
   * Whether the server has Supabase credentials at all. False means sign-in
   * is hidden rather than offered and then broken.
   */
  available: boolean
  /** Whether this server is taking new accounts. */
  registrationOpen: boolean
  /** Closing an account needs a service-role key the server may not have. */
  canDeleteAccount: boolean
  /** In-flight sign-in or sign-up, so the form can disable itself. */
  busy: boolean
  /** Last failure, phrased for a person. */
  error: string | null
  /** Set when a sign-up needs an email confirmation before it can be used. */
  notice: string | null
  /** When the profile was last written to the account. */
  savedAt: number | null
  saving: boolean

  refresh: () => Promise<void>
  signIn: (email: string, password: string) => Promise<boolean>
  signUp: (name: string, email: string, password: string) => Promise<boolean>
  signOut: () => Promise<void>
  signOutEverywhere: () => Promise<void>
  updateAccount: (patch: { name?: string; email?: string }) => Promise<boolean>
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>
  closeAccount: () => Promise<boolean>
  clearError: () => void
  /** Called by the app store whenever the profile changes. Debounced. */
  queueProfileSave: (profile: LearnerProfile) => void
}

/**
 * Server messages are already written for a person — `users.ts` and the Zod
 * schemas both phrase them that way — so the useful thing here is to catch
 * the cases where there is no message at all.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_request') {
      const details = error.details as Array<{ message?: string }> | undefined
      const first = details?.[0]?.message
      if (first) return first
    }
    if (error.code === 'upstream_error' || error.code === 'bad_response') {
      return 'The server is not answering. You can keep working signed out.'
    }
    return error.message
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'That timed out.'
  if (error instanceof TypeError) return 'Could not reach the server.'
  return error instanceof Error ? error.message : String(error)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Only the newest save may win, so a slow one cannot overwrite a fast one. */
let saveToken = 0

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'unknown',
  user: null,
  available: false,
  registrationOpen: true,
  canDeleteAccount: false,
  busy: false,
  error: null,
  notice: null,
  savedAt: null,
  saving: false,

  clearError: () => set({ error: null, notice: null }),

  refresh: async () => {
    try {
      const me = await getAuthMe(AbortSignal.timeout(AUTH_TIMEOUT_MS))
      set({
        status: me.user ? 'signed-in' : 'signed-out',
        user: me.user,
        available: me.available,
        registrationOpen: me.registrationOpen,
        canDeleteAccount: me.canDeleteAccount,
      })
      // A session that survived a reload brings its profile with it.
      if (me.user && me.profile) useAppStore.getState().adoptProfile(me.profile)
    } catch {
      // The server being down is not a signed-in/out question. Treat it as
      // signed out so the UI settles, and say nothing — the connection badge
      // already reports the server.
      set({ status: 'signed-out', user: null, available: false })
    }
  },

  signIn: async (email, password) => {
    set({ busy: true, error: null, notice: null })
    try {
      const session = await postLogin({ email, password }, AbortSignal.timeout(AUTH_TIMEOUT_MS))
      set({ status: 'signed-in', user: session.user, busy: false })

      if (session.profile) {
        useAppStore.getState().adoptProfile(session.profile)
      } else {
        // First sign-in on this account: keep what they were working on.
        get().queueProfileSave(useAppStore.getState().profile)
      }
      return true
    } catch (error) {
      set({ busy: false, error: describe(error) })
      return false
    }
  },

  signUp: async (name, email, password) => {
    set({ busy: true, error: null, notice: null })
    try {
      const session = await postRegister(
        { name, email, password },
        AbortSignal.timeout(AUTH_TIMEOUT_MS),
      )

      // A project with "Confirm email" switched on creates the account but
      // issues no session. Saying so is the whole difference between "it
      // worked, go check your inbox" and "nothing happened".
      if (session.pendingConfirmation || !session.user) {
        set({
          busy: false,
          notice:
            session.message ?? 'Account created. Confirm your email address, then sign in.',
        })
        return false
      }

      set({ status: 'signed-in', user: session.user, busy: false })
      // A new account has no profile, so it adopts the current one — which
      // may already have a goal if they explored before signing up.
      get().queueProfileSave(useAppStore.getState().profile)
      return true
    } catch (error) {
      set({ busy: false, error: describe(error) })
      return false
    }
  },

  signOut: async () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    try {
      await postLogout(AbortSignal.timeout(AUTH_TIMEOUT_MS))
    } catch {
      // The cookie may already be dead. Either way the local state is what
      // the person can see, so clear it and move on.
    }
    set({ status: 'signed-out', user: null, savedAt: null, error: null })
  },

  signOutEverywhere: async () => {
    try {
      await postLogoutAll(AbortSignal.timeout(AUTH_TIMEOUT_MS))
      set({ status: 'signed-out', user: null, savedAt: null })
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  updateAccount: async (patch) => {
    set({ busy: true, error: null })
    try {
      const { user } = await patchAccount(patch, AbortSignal.timeout(AUTH_TIMEOUT_MS))
      set({ user, busy: false })
      // The account name and the learner name are the same name.
      if (patch.name) useAppStore.getState().updateProfile({ name: patch.name })
      return true
    } catch (error) {
      set({ busy: false, error: describe(error) })
      return false
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    set({ busy: true, error: null })
    try {
      await postPasswordChange(
        { currentPassword, newPassword },
        AbortSignal.timeout(AUTH_TIMEOUT_MS),
      )
      // The server ends every session, including this one, on purpose.
      set({ status: 'signed-out', user: null, busy: false, savedAt: null })
      return true
    } catch (error) {
      set({ busy: false, error: describe(error) })
      return false
    }
  },

  closeAccount: async () => {
    set({ busy: true, error: null })
    try {
      await apiDeleteAccount(AbortSignal.timeout(AUTH_TIMEOUT_MS))
      set({ status: 'signed-out', user: null, busy: false, savedAt: null })
      return true
    } catch (error) {
      set({ busy: false, error: describe(error) })
      return false
    }
  },

  queueProfileSave: (profile) => {
    if (get().status !== 'signed-in') return

    if (saveTimer) clearTimeout(saveTimer)
    const token = ++saveToken

    saveTimer = setTimeout(() => {
      saveTimer = null
      set({ saving: true })
      void putSavedProfile(profile, AbortSignal.timeout(AUTH_TIMEOUT_MS))
        .then((result) => {
          if (token !== saveToken) return
          set({ saving: false, savedAt: result.savedAt })
        })
        .catch(() => {
          if (token !== saveToken) return
          // A failed sync is not worth interrupting anyone over: the profile
          // is still in localStorage and will go up on the next edit.
          set({ saving: false })
        })
    }, SAVE_DEBOUNCE_MS)
  },
}))
