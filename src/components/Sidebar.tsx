/**
 * The sidebar, in three states.
 *
 *   expanded   the default on a wide screen
 *   collapsed  a 56px rail of icons, toggled by the chevron and remembered
 *              across reloads. Labels move into tooltips rather than
 *              disappearing, so the rail stays usable rather than becoming a
 *              guessing game
 *   drawer     under 900px it slides in over the content, as before. Collapse
 *              is meaningless there — a rail is not what a phone needs — so
 *              the toggle is hidden and the drawer always shows labels
 */

import { NavLink } from 'react-router-dom'
import {
  ClipboardCheck,
  LayoutGrid,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Settings,
} from 'lucide-react'
import { getGoal } from '@/lib/goals'
import { useProgress } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { useAuthStore } from '@/store/useAuthStore'

const NAV = [
  { to: '/', label: 'Assistant', Icon: MessageSquare, end: true },
  { to: '/path', label: 'Learning path', Icon: Route, end: false },
  { to: '/dashboard', label: 'Dashboard', Icon: LayoutGrid, end: false },
  { to: '/assess', label: 'Assessment', Icon: ClipboardCheck, end: false },
  { to: '/settings', label: 'Settings', Icon: Settings, end: false },
]

export function Sidebar({
  open,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: {
  /** Drawer state, mobile only. */
  open: boolean
  /** Rail state, desktop only. */
  collapsed: boolean
  onToggleCollapsed: () => void
  onNavigate: () => void
}) {
  const path = useAppStore((s) => s.path)
  const profile = useAppStore((s) => s.profile)
  const progress = useProgress()
  const goal = getGoal(profile.goalId)

  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const available = useAuthStore((s) => s.available)

  const counts: Record<string, string | undefined> = {
    '/path': progress.total > 0 ? `${progress.done}/${progress.total}` : undefined,
  }

  const classes = [
    'sidebar',
    open ? 'sidebar--open' : '',
    collapsed ? 'sidebar--collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <aside className={classes}>
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          P
        </span>
        <span className="sidebar__name">Pathfinder</span>

        <button
          type="button"
          className="btn btn--ghost btn--icon sidebar__collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <nav className="sidebar__nav" aria-label="Main">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            // The title is what makes the collapsed rail navigable, so it is
            // set only when the label is not on screen to read.
            title={collapsed ? label : undefined}
            className={({ isActive }) => `navitem ${isActive ? 'navitem--active' : ''}`}
          >
            <Icon size={15} strokeWidth={1.75} />
            <span className="navitem__label">{label}</span>
            {counts[to] && <span className="navitem__count mono">{counts[to]}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__section sidebar__hide-collapsed">
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
        <NavLink
          to={status === 'signed-in' || !available ? '/settings' : '/login'}
          onClick={onNavigate}
          className="sidebar__account"
          title={
            status === 'signed-in'
              ? `Signed in as ${user?.email ?? ''}`
              : available
                ? 'Sign in'
                : profile.name
          }
        >
          <span className="sidebar__mark" aria-hidden="true">
            {(user?.name ?? profile.name).charAt(0).toUpperCase()}
          </span>
          <span className="sidebar__account-text">
            <span className="sidebar__account-name">{user?.name ?? profile.name}</span>
            <span className="sidebar__account-sub">
              {status === 'signed-in'
                ? user?.email
                : available
                  ? 'Not signed in — sign in'
                  : `${profile.completed.length} completed`}
            </span>
          </span>
        </NavLink>
      </div>
    </aside>
  )
}
