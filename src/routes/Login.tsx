/**
 * Sign in, or don't.
 *
 * The escape hatch is the important part of this screen. This app has always
 * worked with the server stopped, and an account only buys you the same
 * profile in two browsers — so putting a wall here would take something away
 * and give nothing back. "Continue without an account" is a first-class
 * choice, not a grudging link in the corner.
 *
 * Identity is Supabase Auth, reached through our own API so that tokens stay
 * in httpOnly cookies rather than localStorage. Nothing on this page ever
 * holds a token.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ArrowRight, Check, Loader2, ShieldOff } from 'lucide-react'
import { useAuthStore } from '@/store/useAuthStore'

type Mode = 'signin' | 'signup'

export function LoginRoute() {
  const navigate = useNavigate()
  const status = useAuthStore((s) => s.status)
  const available = useAuthStore((s) => s.available)
  const registrationOpen = useAuthStore((s) => s.registrationOpen)
  const busy = useAuthStore((s) => s.busy)
  const error = useAuthStore((s) => s.error)
  const notice = useAuthStore((s) => s.notice)
  const signIn = useAuthStore((s) => s.signIn)
  const signUp = useAuthStore((s) => s.signUp)
  const clearError = useAuthStore((s) => s.clearError)

  const [mode, setMode] = useState<Mode>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // Switching tabs should not carry the previous attempt's failure with it.
  useEffect(() => {
    clearError()
  }, [mode, clearError])

  if (status === 'signed-in') return <Navigate to="/" replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    const ok =
      mode === 'signin'
        ? await signIn(email, password)
        : await signUp(name, email, password)
    if (ok) navigate('/', { replace: true })
  }

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <span className="sidebar__mark" aria-hidden="true">
            P
          </span>
          <span>Pathfinder</span>
        </div>

        <h1 className="auth__title">
          {mode === 'signin' ? 'Sign in' : 'Create an account'}
        </h1>
        <p className="auth__lede">
          An account keeps one learning profile across browsers. Everything else works
          without one.
        </p>

        {!available ? (
          <div className="auth__unavailable">
            <ShieldOff size={15} strokeWidth={1.75} />
            <div>
              <strong>Accounts are turned off on this server.</strong>
              <p>
                No Supabase credentials are configured, so there is nothing to sign in to.
                The app is fully usable without an account.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="auth__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signin'}
                className={`auth__tab ${mode === 'signin' ? 'auth__tab--on' : ''}`}
                onClick={() => setMode('signin')}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signup'}
                className={`auth__tab ${mode === 'signup' ? 'auth__tab--on' : ''}`}
                onClick={() => setMode('signup')}
                disabled={!registrationOpen}
                title={registrationOpen ? undefined : 'This server is not taking new accounts.'}
              >
                Create account
              </button>
            </div>

            <form className="auth__form" onSubmit={submit}>
              {mode === 'signup' && (
                <label className="auth__field">
                  <span className="label">Name</span>
                  <input
                    className="input"
                    autoComplete="name"
                    maxLength={120}
                    placeholder="What should we call you?"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}

              <label className="auth__field">
                <span className="label">Email</span>
                <input
                  className="input"
                  type="email"
                  required
                  autoComplete="email"
                  maxLength={254}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              <label className="auth__field">
                <span className="label">Password</span>
                <input
                  className="input"
                  type="password"
                  required
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  maxLength={200}
                  placeholder={mode === 'signup' ? 'At least 10 characters' : ''}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === 'signup' && (
                  <span className="auth__hint">
                    Length is the only rule. A short sentence beats a mangled word.
                  </span>
                )}
              </label>

              {error && (
                <p className="auth__error" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="auth__notice" role="status">
                  <Check size={14} strokeWidth={2} />
                  {notice}
                </p>
              )}

              <button className="btn btn--primary auth__submit" type="submit" disabled={busy}>
                {busy && <Loader2 size={14} className="spin" />}
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>
          </>
        )}

        <div className="auth__divider">
          <span>or</span>
        </div>

        <Link className="btn btn--ghost auth__guest" to="/">
          Continue without an account
          <ArrowRight size={14} strokeWidth={1.75} />
        </Link>

        <p className="auth__foot">
          Your profile stays in this browser either way. Signing in copies it to your
          account so another browser can pick it up.
        </p>
      </div>
    </div>
  )
}
