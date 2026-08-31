import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { ConnectionBadge } from '@/components/ConnectionBadge'
import { Sidebar } from '@/components/Sidebar'
import { ThemeToggle } from '@/components/ThemeToggle'
import { AssessRoute } from '@/routes/Assess'
import { ChatRoute } from '@/routes/Chat'
import { DashboardRoute } from '@/routes/Dashboard'
import { LoginRoute } from '@/routes/Login'
import { PathRoute } from '@/routes/Path'
import { SettingsRoute } from '@/routes/Settings'
import { useAppStore } from '@/store/useAppStore'
import { useAuthStore } from '@/store/useAuthStore'

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Assistant', sub: 'Describe a goal in your own words' },
  '/path': { title: 'Learning path', sub: 'Sequenced roadmap with prerequisites' },
  '/dashboard': { title: 'Dashboard', sub: 'Progress, skills and next actions' },
  '/settings': { title: 'Settings', sub: 'Account, profile and what drives the plan' },
  '/assess': { title: 'Assessment', sub: 'Measure a level instead of assuming it' },
}

const COLLAPSE_KEY = 'pf-nav-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    // Private mode or blocked storage. Expanded is the better default.
    return false
  }
}

export default function App() {
  const { pathname } = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const regenerate = useAppStore((s) => s.regenerate)
  const checkConnection = useAppStore((s) => s.checkConnection)
  const profile = useAppStore((s) => s.profile)
  const progress = useAppStore((s) => s.status)
  const messages = useAppStore((s) => s.messages)

  const refreshAuth = useAuthStore((s) => s.refresh)
  const authStatus = useAuthStore((s) => s.status)
  const queueStateSave = useAuthStore((s) => s.queueStateSave)

  // Build an initial path if the seeded profile already has a goal, find out
  // whether there is an API to build it with, and ask who is signed in. None
  // of the three blocks the render: the local engine answers immediately, and
  // signed out is a perfectly good state to render.
  useEffect(() => {
    regenerate()
    void checkConnection()
    void refreshAuth()
  }, [regenerate, checkConnection, refreshAuth])

  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  /**
   * Push the whole learner up to the account: what they assert (profile),
   * what they have done (progress) and how they got there (conversation).
   * Debounced inside the auth store, and a no-op when signed out — which is
   * why this can be one plain effect rather than something threaded through
   * every action that touches any of the three.
   *
   * Deliberately keyed on `authStatus` too, so signing in flushes whatever is
   * currently on screen instead of waiting for the next keystroke.
   */
  useEffect(() => {
    if (authStatus !== 'signed-in') return
    queueStateSave({ profile, progress, conversation: messages })
  }, [profile, progress, messages, authStatus, queueStateSave])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        // Not fatal — the choice just will not survive a reload.
      }
      return next
    })
  }, [])

  // Sign-in is its own screen: no sidebar, no topbar, nothing to navigate
  // away into before you have decided what you are doing.
  if (pathname === '/login') return <LoginRoute />

  const head = TITLES[pathname] ?? { title: 'Pathfinder', sub: '' }

  return (
    <div className={`app ${collapsed ? 'app--collapsed' : ''}`}>
      <Sidebar
        open={navOpen}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onNavigate={() => setNavOpen(false)}
      />
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn--ghost btn--icon nav-toggle"
            aria-label="Open navigation"
            onClick={() => setNavOpen(true)}
          >
            <Menu size={16} />
          </button>
          <div>
            <div className="topbar__title">{head.title}</div>
          </div>
          <div className="topbar__sub">{head.sub}</div>
          <div className="topbar__actions">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </header>

        <main className="content">
          <Routes>
            <Route path="/" element={<ChatRoute />} />
            <Route path="/path" element={<PathRoute />} />
            <Route path="/dashboard" element={<DashboardRoute />} />
            <Route path="/settings" element={<SettingsRoute />} />
            {/* The profile page grew into settings; old links still work. */}
            <Route path="/profile" element={<Navigate to="/settings" replace />} />
            <Route path="/assess" element={<AssessRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
