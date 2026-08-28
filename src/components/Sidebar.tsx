import { NavLink } from 'react-router-dom'
import { ClipboardCheck, LayoutGrid, MessageSquare, Route, User } from 'lucide-react'
import { getGoal } from '@/lib/goals'
import { useProgress } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'

const NAV = [
  { to: '/', label: 'Assistant', Icon: MessageSquare, end: true },
  { to: '/path', label: 'Learning path', Icon: Route, end: false },
  { to: '/dashboard', label: 'Dashboard', Icon: LayoutGrid, end: false },
  { to: '/assess', label: 'Assessment', Icon: ClipboardCheck, end: false },
  { to: '/profile', label: 'Profile', Icon: User, end: false },
]

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const path = useAppStore((s) => s.path)
  const profile = useAppStore((s) => s.profile)
  const progress = useProgress()
  const goal = getGoal(profile.goalId)

  const counts: Record<string, string | undefined> = {
    '/path': progress.total > 0 ? `${progress.done}/${progress.total}` : undefined,
  }

  return (
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          P
        </span>
        <span className="sidebar__name">Pathfinder</span>
      </div>

      <nav className="sidebar__nav" aria-label="Main">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) => `navitem ${isActive ? 'navitem--active' : ''}`}
          >
            <Icon size={15} strokeWidth={1.75} />
            <span>{label}</span>
            {counts[to] && <span className="navitem__count mono">{counts[to]}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__section">
        <div className="label" style={{ marginBottom: 'var(--s-2)' }}>
          Current goal
        </div>
        {goal ? (
          <div className="stack stack--2">
            <div style={{ fontSize: 'var(--t-md)', fontWeight: 500 }}>{goal.title}</div>
            {path && (
              <div className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
                {path.milestones.length} milestones · {path.weeks} wks
              </div>
            )}
          </div>
        ) : (
          <p className="faint" style={{ fontSize: 'var(--t-sm)' }}>
            Not set. Describe it in the assistant.
          </p>
        )}
      </div>

      <div className="sidebar__foot">
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <span className="sidebar__mark" aria-hidden="true" style={{ borderColor: 'var(--line-strong)' }}>
            {profile.name.charAt(0).toUpperCase()}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--t-sm)', fontWeight: 500 }}>{profile.name}</div>
            <div className="faint" style={{ fontSize: 'var(--t-xs)' }}>
              {profile.completed.length} completed
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
