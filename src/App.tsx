import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Menu } from 'lucide-react'
import { ConnectionBadge } from '@/components/ConnectionBadge'
import { Sidebar } from '@/components/Sidebar'
import { ThemeToggle } from '@/components/ThemeToggle'
import { AssessRoute } from '@/routes/Assess'
import { ChatRoute } from '@/routes/Chat'
import { DashboardRoute } from '@/routes/Dashboard'
import { PathRoute } from '@/routes/Path'
import { ProfileRoute } from '@/routes/Profile'
import { useAppStore } from '@/store/useAppStore'

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Assistant', sub: 'Describe a goal in your own words' },
  '/path': { title: 'Learning path', sub: 'Sequenced roadmap with prerequisites' },
  '/dashboard': { title: 'Dashboard', sub: 'Progress, skills and next actions' },
  '/profile': { title: 'Profile', sub: 'What the recommendations are based on' },
  '/assess': { title: 'Assessment', sub: 'Measure a level instead of assuming it' },
}

export default function App() {
  const { pathname } = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const regenerate = useAppStore((s) => s.regenerate)
  const checkConnection = useAppStore((s) => s.checkConnection)

  // Build an initial path if the seeded profile already has a goal, and find
  // out whether there is an API to build it with. Neither blocks the render:
  // the local engine answers immediately either way.
  useEffect(() => {
    regenerate()
    void checkConnection()
  }, [regenerate, checkConnection])

  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  const head = TITLES[pathname] ?? { title: 'Pathfinder', sub: '' }

  return (
    <div className="app">
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
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
            <Route path="/profile" element={<ProfileRoute />} />
            <Route path="/assess" element={<AssessRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
