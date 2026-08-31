/**
 * Settings.
 *
 * Laid out the way settings pages that work are laid out: a section list on
 * the left, and rows of label + explanation + control on the right, one idea
 * per row. The explanation is not decoration — every setting here changes
 * what the engine recommends, and a control whose effect you have to guess
 * is a control people leave alone.
 *
 * The sections split along a real seam. **Account** is the only one that
 * talks to a server; everything below it is local state that drives the
 * recommendation engine and works signed out, offline, forever.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Check as CheckIcon,
  CloudOff,
  Gauge,
  History,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Sun,
  Target,
  User as UserIcon,
} from 'lucide-react'
import { Badge, Check, KindMark, Meter, Panel } from '@/components/ui'
import { ALL_TAGS, RESOURCES, SKILLS, skillName } from '@/lib/catalog'
import { hours as fmtHours } from '@/lib/format'
import { GOALS } from '@/lib/goals'
import {
  LEVEL_LABELS,
  PACE_LABELS,
  type LearnerProfile,
  type Level,
  type Pace,
  type SkillDomain,
} from '@/lib/types'
import { useSkillLevels } from '@/store/selectors'
import { useAppStore, type ThemeChoice } from '@/store/useAppStore'
import { useAuthStore } from '@/store/useAuthStore'

type SectionId = 'account' | 'profile' | 'skills' | 'history' | 'appearance'

const SECTIONS: Array<{ id: SectionId; label: string; Icon: typeof UserIcon }> = [
  { id: 'account', label: 'Account', Icon: UserIcon },
  { id: 'profile', label: 'Learning profile', Icon: Target },
  { id: 'skills', label: 'Skill levels', Icon: Gauge },
  { id: 'history', label: 'History', Icon: History },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
]

const EXPERIENCE_OPTIONS: Array<{ value: LearnerProfile['experience']; label: string }> = [
  { value: 'beginner', label: 'New to the field' },
  { value: 'some', label: 'Some exposure' },
  { value: 'experienced', label: 'Working professional' },
]

const DOMAIN_LABELS: Record<SkillDomain, string> = {
  foundations: 'Foundations',
  data: 'Data & ML',
  engineering: 'Engineering',
  infrastructure: 'Infrastructure',
}

const THEMES: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

/** One setting: what it is, what it does, and the control that changes it. */
function Row({
  label,
  hint,
  children,
  stacked,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  /** For controls too wide to sit beside their label. */
  stacked?: boolean
}) {
  return (
    <div className={`setrow ${stacked ? 'setrow--stacked' : ''}`}>
      <div className="setrow__text">
        <div className="setrow__label">{label}</div>
        {hint && <p className="setrow__hint">{hint}</p>}
      </div>
      <div className="setrow__control">{children}</div>
    </div>
  )
}

export function SettingsRoute() {
  const [section, setSection] = useState<SectionId>('account')

  return (
    <div className="page settings">
      <div className="page__head">
        <div>
          <h1>Settings</h1>
          <p>
            Everything the recommendation engine reads. Change anything below the account
            section and the path rebuilds immediately.
          </p>
        </div>
      </div>

      <div className="settings__body">
        <nav className="settings__nav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`settings__tab ${section === id ? 'settings__tab--on' : ''}`}
              aria-current={section === id}
              onClick={() => setSection(id)}
            >
              <Icon size={15} strokeWidth={1.75} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="settings__panel">
          {section === 'account' && <AccountSection />}
          {section === 'profile' && <ProfileSection />}
          {section === 'skills' && <SkillsSection />}
          {section === 'history' && <HistorySection />}
          {section === 'appearance' && <AppearanceSection />}
        </div>
      </div>
    </div>
  )
}

// ---- account ------------------------------------------------------------

function AccountSection() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const available = useAuthStore((s) => s.available)
  const canDelete = useAuthStore((s) => s.canDeleteAccount)
  const busy = useAuthStore((s) => s.busy)
  const error = useAuthStore((s) => s.error)
  const saving = useAuthStore((s) => s.saving)
  const savedAt = useAuthStore((s) => s.savedAt)
  const signOut = useAuthStore((s) => s.signOut)
  const signOutEverywhere = useAuthStore((s) => s.signOutEverywhere)
  const updateAccount = useAuthStore((s) => s.updateAccount)
  const changePassword = useAuthStore((s) => s.changePassword)
  const closeAccount = useAuthStore((s) => s.closeAccount)

  const [displayName, setDisplayName] = useState(user?.name ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    setDisplayName(user?.name ?? '')
  }, [user?.name])

  // A confirmation that outlives the thing it confirmed is just clutter.
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(null), 4000)
    return () => clearTimeout(timer)
  }, [done])

  if (status === 'signed-out' || !user) {
    return (
      <Panel title="Account">
        <div className="settings__empty">
          {available ? (
            <>
              <p>
                You are not signed in. Everything works anyway — your profile lives in this
                browser. An account copies it somewhere another browser can reach.
              </p>
              <Link className="btn btn--primary" to="/login">
                Sign in or create an account
              </Link>
            </>
          ) : (
            <>
              <p className="row" style={{ gap: 'var(--s-2)', alignItems: 'flex-start' }}>
                <CloudOff size={16} strokeWidth={1.75} />
                <span>
                  Accounts are turned off on this server — no Supabase credentials are
                  configured. Your profile is saved in this browser only.
                </span>
              </p>
            </>
          )}
        </div>
      </Panel>
    )
  }

  return (
    <div className="stack stack--4">
      <Panel title="Account">
        <div className="setrows">
          <Row label="Email" hint="The address you sign in with.">
            <span className="mono faint">{user.email}</span>
          </Row>

          <Row
            label="Display name"
            hint="Used in the assistant and on your profile. Also the name the engine sees."
          >
            <div className="row" style={{ gap: 'var(--s-2)' }}>
              <input
                className="input"
                maxLength={120}
                style={{ width: 200 }}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || displayName.trim() === user.name || !displayName.trim()}
                onClick={async () => {
                  if (await updateAccount({ name: displayName.trim() })) setDone('Name saved.')
                }}
              >
                Save
              </button>
            </div>
          </Row>

          <Row
            label="Profile sync"
            hint="Your learning profile is written to your account a moment after each change."
          >
            <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>
              {saving ? (
                <span className="row" style={{ gap: 'var(--s-1)' }}>
                  <Loader2 size={13} className="spin" /> Saving…
                </span>
              ) : savedAt ? (
                <span className="row" style={{ gap: 'var(--s-1)' }}>
                  <CheckIcon size={13} /> Saved {new Date(savedAt).toLocaleTimeString()}
                </span>
              ) : (
                'Nothing to save yet'
              )}
            </span>
          </Row>
        </div>
      </Panel>

      <Panel title="Password">
        <div className="setrows">
          <Row
            label="Change password"
            hint="Changing it signs you out everywhere, including here — that is the point of changing it."
            stacked
          >
            <div className="row row--wrap" style={{ gap: 'var(--s-2)' }}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                style={{ width: 200 }}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                style={{ width: 200 }}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || !currentPassword || newPassword.length < 10}
                onClick={async () => {
                  if (await changePassword(currentPassword, newPassword)) {
                    setCurrentPassword('')
                    setNewPassword('')
                  }
                }}
              >
                Update
              </button>
            </div>
          </Row>
        </div>
      </Panel>

      <Panel title="Sessions">
        <div className="setrows">
          <Row label="Sign out" hint="Ends this session. Your profile stays in this browser.">
            <button type="button" className="btn" onClick={() => void signOut()}>
              <LogOut size={14} strokeWidth={1.75} />
              Sign out
            </button>
          </Row>

          <Row
            label="Sign out everywhere"
            hint="Ends every session on every device. Useful after a shared laptop."
          >
            <button type="button" className="btn" onClick={() => void signOutEverywhere()}>
              Sign out everywhere
            </button>
          </Row>
        </div>
      </Panel>

      <Panel title="Danger zone">
        <div className="setrows">
          <Row
            label="Delete account"
            hint={
              canDelete
                ? 'Deletes your account and the profile saved against it. This cannot be undone. The copy in this browser is left alone.'
                : 'Unavailable: the server has no service-role key, which account deletion requires.'
            }
          >
            {confirmingDelete ? (
              <div className="row" style={{ gap: 'var(--s-2)' }}>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={async () => {
                    if (await closeAccount()) setConfirmingDelete(false)
                  }}
                >
                  Yes, delete it
                </button>
                <button type="button" className="btn" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--danger"
                disabled={!canDelete}
                onClick={() => setConfirmingDelete(true)}
              >
                <AlertTriangle size={14} strokeWidth={1.75} />
                Delete account
              </button>
            )}
          </Row>
        </div>
      </Panel>

      {error && (
        <p className="auth__error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="auth__notice" role="status">
          <CheckIcon size={14} /> {done}
        </p>
      )}
    </div>
  )
}

// ---- learning profile ---------------------------------------------------

function ProfileSection() {
  const profile = useAppStore((s) => s.profile)
  const updateProfile = useAppStore((s) => s.updateProfile)
  const toggleInterest = useAppStore((s) => s.toggleInterest)
  const setPace = useAppStore((s) => s.setPace)
  const setGoal = useAppStore((s) => s.setGoal)

  return (
    <div className="stack stack--4">
      <Panel title="What you are aiming at">
        <div className="setrows">
          <Row label="Name" hint="How the assistant addresses you.">
            <input
              className="input"
              maxLength={120}
              style={{ width: 200 }}
              value={profile.name}
              onChange={(e) => updateProfile({ name: e.target.value })}
            />
          </Row>

          <Row
            label="Experience"
            hint="Sets the baseline before your completed history is considered."
          >
            <select
              className="select"
              style={{ width: 200 }}
              value={profile.experience}
              onChange={(e) =>
                updateProfile({ experience: e.target.value as LearnerProfile['experience'] })
              }
            >
              {EXPERIENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Goal" hint="Or describe it in your own words in the assistant.">
            <select
              className="select"
              style={{ width: 200 }}
              value={profile.goalId ?? ''}
              onChange={(e) => setGoal(e.target.value)}
            >
              <option value="" disabled>
                Select a goal…
              </option>
              {GOALS.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.title}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Weekly pace" hint="Drives the schedule estimate, not the content.">
            <select
              className="select"
              style={{ width: 200 }}
              value={profile.pace}
              onChange={(e) => setPace(e.target.value as Pace)}
            >
              {(Object.keys(PACE_LABELS) as Pace[]).map((pace) => (
                <option key={pace} value={pace}>
                  {PACE_LABELS[pace]}
                </option>
              ))}
            </select>
          </Row>

          {profile.goalStatement && (
            <Row label="In your words" hint="The statement the goal was read from.">
              <p className="muted" style={{ fontSize: 'var(--t-sm)', maxWidth: '40ch' }}>
                “{profile.goalStatement}”
              </p>
            </Row>
          )}
        </div>
      </Panel>

      <Panel
        title="Interests"
        actions={
          <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
            {profile.interests.length} selected
          </span>
        }
      >
        <p className="muted" style={{ fontSize: 'var(--t-sm)', marginBottom: 'var(--s-4)' }}>
          Used to break ties between resources that close the same skill gap. They never add
          anything to the path that would not otherwise be there.
        </p>
        <div className="row row--wrap">
          {ALL_TAGS.map((tag) => {
            const on = profile.interests.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                className={`chip ${on ? 'chip--on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleInterest(tag)}
              >
                {tag}
              </button>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

// ---- skills -------------------------------------------------------------

function SkillsSection() {
  const levels = useSkillLevels()
  const setSelfRated = useAppStore((s) => s.setSelfRated)
  const byDomain = (domain: SkillDomain) => SKILLS.filter((skill) => skill.domain === domain)

  return (
    <Panel
      title="Skill levels"
      actions={
        <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
          derived from history · override below
        </span>
      }
    >
      <p className="muted" style={{ fontSize: 'var(--t-sm)', marginBottom: 'var(--s-4)' }}>
        Levels are inferred from what you have completed. Where that is wrong, set it
        yourself — a manual rating always wins if it is higher. To measure one instead of
        asserting it, take an assessment.
      </p>

      <div className="grid grid--2">
        {(Object.keys(DOMAIN_LABELS) as SkillDomain[]).map((domain) => (
          <div key={domain} className="stack stack--3">
            <span className="label">{DOMAIN_LABELS[domain]}</span>
            <div className="rows panel" style={{ borderRadius: 'var(--radius)' }}>
              {byDomain(domain).map((skill) => {
                const level = levels[skill.id] ?? 0
                return (
                  <div className="rowitem" key={skill.id}>
                    <div className="rowitem__main">
                      <div style={{ fontSize: 'var(--t-md)' }}>{skill.name}</div>
                      <div className="rowitem__meta">{LEVEL_LABELS[level]}</div>
                    </div>
                    <Meter level={level} small />
                    <select
                      className="select"
                      style={{ width: 78, height: 26, fontSize: 'var(--t-sm)' }}
                      value={level}
                      aria-label={`Set ${skill.name} level`}
                      onChange={(e) => setSelfRated(skill.id, Number(e.target.value) as Level)}
                    >
                      {[0, 1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

// ---- history ------------------------------------------------------------

function HistorySection() {
  const profile = useAppStore((s) => s.profile)
  const toggleCompleted = useAppStore((s) => s.toggleCompleted)

  return (
    <Panel
      title="Learning history"
      actions={
        <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
          {profile.completed.length} of {RESOURCES.length} completed
        </span>
      }
      flush
    >
      <div className="rows">
        {RESOURCES.map((resource) => {
          const done = profile.completed.includes(resource.id)
          const teaches = Object.keys(resource.teaches)
          return (
            <div className={`res ${done ? 'res--done' : ''}`} key={resource.id}>
              <Check
                checked={done}
                onChange={() => toggleCompleted(resource.id)}
                label={`Mark ${resource.title} as completed`}
              />
              <KindMark kind={resource.kind} />
              <div className="res__main">
                <div className="res__title">{resource.title}</div>
                <div className="res__meta">
                  <span>{resource.provider}</span>
                  <span>{fmtHours(resource.hours)}</span>
                  {teaches.length > 0 && <span>{teaches.map(skillName).join(', ')}</span>}
                </div>
              </div>
              {done && <Badge tone="ok">completed</Badge>}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// ---- appearance ---------------------------------------------------------

function AppearanceSection() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  return (
    <Panel title="Appearance">
      <div className="setrows">
        <Row label="Theme" hint="System follows whatever your operating system is set to.">
          <div className="segmented">
            {THEMES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                className={`segmented__item ${theme === value ? 'segmented__item--on' : ''}`}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                <Icon size={14} strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </div>
        </Row>
      </div>
    </Panel>
  )
}
