import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, MessageSquare, PenLine, RefreshCw } from 'lucide-react'
import { ApiError, postNarrate } from '@/lib/api'
import { getResource, skillName } from '@/lib/catalog'
import { findPathItem } from '@/lib/engine'
import { getGoal } from '@/lib/goals'
import { hours as fmtHours, weeks as fmtWeeks } from '@/lib/format'
import { PACE_HOURS, type Milestone, type PathItem } from '@/lib/types'
import { useProgress } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Bar, Check, Empty, KindMark, Panel } from '@/components/ui'

const REASON_MARK: Record<PathItem['reasons'][number]['kind'], string> = {
  gap: 'GAP',
  prereq: 'PRE',
  interest: 'INT',
  history: 'HIS',
  level: 'LVL',
  goal: 'OUT',
}

function MilestoneBlock({ milestone, index, total }: { milestone: Milestone; index: number; total: number }) {
  const status = useAppStore((s) => s.status)
  const toggleDone = useAppStore((s) => s.toggleDone)
  const focused = useAppStore((s) => s.focusedResource)
  const focusResource = useAppStore((s) => s.focusResource)

  const doneCount = milestone.items.filter((i) => status[i.resourceId] === 'done').length
  const allDone = doneCount === milestone.items.length
  const started = doneCount > 0
  const milestoneHours = milestone.items.reduce(
    (sum, i) => sum + (getResource(i.resourceId)?.hours ?? 0),
    0,
  )

  return (
    <div className="mstone">
      <div className="mstone__rail">
        <div
          className={`mstone__node ${allDone ? 'mstone__node--done' : started ? 'mstone__node--active' : ''}`}
        >
          {index + 1}
        </div>
        {index < total - 1 && <div className={`mstone__line ${allDone ? 'mstone__line--done' : ''}`} />}
      </div>

      <div className="mstone__body">
        <div className="mstone__head">
          <h3 className="mstone__title">{milestone.title}</h3>
          {allDone ? (
            <Badge tone="ok">Complete</Badge>
          ) : started ? (
            <Badge tone="accent">In progress</Badge>
          ) : (
            <Badge>Not started</Badge>
          )}
          <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
            {doneCount}/{milestone.items.length} · {fmtHours(milestoneHours)}
          </span>
        </div>

        <p className="mstone__outcome">{milestone.outcome}</p>

        {milestone.entryRequirements.length > 0 && (
          <p className="faint" style={{ fontSize: 'var(--t-sm)', marginBottom: 'var(--s-3)' }}>
            Assumes: {milestone.entryRequirements.map(skillName).join(', ')}
          </p>
        )}

        <Panel flush>
          <div className="rows">
            {milestone.items.map((item) => {
              const resource = getResource(item.resourceId)
              if (!resource) return null
              const isDone = status[item.resourceId] === 'done'
              const isFocused = focused === item.resourceId

              return (
                <div
                  key={item.resourceId}
                  className={`res res--clickable ${isDone ? 'res--done' : ''} ${isFocused ? 'res--on' : ''}`}
                  onClick={() => focusResource(isFocused ? null : item.resourceId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      focusResource(isFocused ? null : item.resourceId)
                    }
                  }}
                >
                  <Check
                    checked={isDone}
                    onChange={() => toggleDone(item.resourceId)}
                    label={`Mark ${resource.title} complete`}
                  />
                  <KindMark kind={resource.kind} />
                  <div className="res__main">
                    <div className="res__title">{resource.title}</div>
                    <div className="res__meta">
                      <span>{resource.provider}</span>
                      <span>{fmtHours(resource.hours)}</span>
                      <span>L{resource.level}</span>
                    </div>
                  </div>
                  <div className="res__actions">
                    <span
                      className="faint"
                      title="Show why this was recommended"
                      style={{ display: 'flex', alignItems: 'center' }}
                    >
                      <Info size={14} />
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>
    </div>
  )
}

function WhyRail() {
  const focused = useAppStore((s) => s.focusedResource)
  const path = useAppStore((s) => s.path)
  const profile = useAppStore((s) => s.profile)
  const connection = useAppStore((s) => s.connection)

  /** Prose keyed by resource id. Cleared whenever the plan changes. */
  const [prose, setProse] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // The reasons are derived from the path, so prose written about an older
  // path is wrong. Throw it away rather than show a stale explanation.
  useEffect(() => {
    setProse({})
    setNote(null)
  }, [path])

  const resource = focused ? getResource(focused) : null
  const item = findPathItem(path, focused ?? '')
  const goal = getGoal(profile.goalId)

  // Only offer this when there is a model behind the API. Without one the
  // endpoint returns the reasons joined into a paragraph, which is what the
  // panel already shows — a button that reprints the page is not a feature.
  const canNarrate = connection.status === 'online' && connection.model !== null

  async function writeProse(resourceId: string) {
    setBusy(resourceId)
    setNote(null)
    try {
      const result = await postNarrate(profile, resourceId, 'coaching')
      if (result.source === 'llm') {
        setProse((current) => ({ ...current, [resourceId]: result.text }))
      } else {
        // The server answered, but its own fallback ran. Say so instead of
        // presenting the templated text as if a model had written it.
        setNote('The model was unavailable, so the reasons below are the explanation.')
      }
    } catch (error) {
      setNote(
        error instanceof ApiError
          ? `Could not write it: ${error.message}`
          : 'Could not reach the API.',
      )
    } finally {
      setBusy(null)
    }
  }

  if (!resource || !item) {
    return (
      <div className="rail">
        <Panel title="Why this?">
          <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
            Select any item in the path to see exactly what put it there — which skill gap it
            closes, what it unlocks, and how it connects to your stated goal.
          </p>
        </Panel>
      </div>
    )
  }

  const written = prose[resource.id]

  return (
    <div className="rail">
      <Panel
        title={<h3>Why this?</h3>}
        actions={<KindMark kind={resource.kind} />}
      >
        <div className="stack stack--4">
          <div>
            <div className="res__title" style={{ marginBottom: 'var(--s-1)' }}>{resource.title}</div>
            <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>{resource.summary}</p>
          </div>

          {written && (
            <div className="why__prose">
              <p>{written}</p>
              <p className="why__prose-by">
                Written by {connection.model} from the reasons below. The reasons are the
                decision; this is only the wording.
              </p>
            </div>
          )}

          {canNarrate && !written && (
            <div>
              <button
                className="btn btn--sm"
                onClick={() => void writeProse(resource.id)}
                disabled={busy === resource.id}
              >
                <PenLine size={13} /> {busy === resource.id ? 'Writing…' : 'Explain in prose'}
              </button>
            </div>
          )}

          {note && (
            <p className="faint" style={{ fontSize: 'var(--t-sm)' }}>
              {note}
            </p>
          )}

          <div className="divider" />

          <div className="why">
            {item.reasons.map((reason, i) => (
              <div className="why__reason" key={i}>
                <span className="why__marker">{REASON_MARK[reason.kind]}</span>
                <span>{reason.text}</span>
              </div>
            ))}
          </div>

          {item.closes.length > 0 && (
            <>
              <div className="divider" />
              <dl className="why__kv">
                <dt>Moves</dt>
                <dd>
                  {item.closes.map((c) => (
                    <div key={c.skillId}>
                      {skillName(c.skillId)} <span className="mono faint">{c.from} → {c.to}</span>
                    </div>
                  ))}
                </dd>
                <dt>Effort</dt>
                <dd className="mono">{fmtHours(resource.hours)}</dd>
                <dt>Provider</dt>
                <dd>{resource.provider}</dd>
                {goal && (
                  <>
                    <dt>Goal</dt>
                    <dd>{goal.title}</dd>
                  </>
                )}
              </dl>
            </>
          )}
        </div>
      </Panel>
    </div>
  )
}

export function PathRoute() {
  const path = useAppStore((s) => s.path)
  const profile = useAppStore((s) => s.profile)
  const progress = useProgress()
  const regenerate = useAppStore((s) => s.regenerate)
  const navigate = useNavigate()
  const goal = getGoal(profile.goalId)

  if (!path || !goal) {
    return (
      <div className="page">
        <Empty
          title="No path yet"
          action={
            <button className="btn btn--primary" onClick={() => navigate('/')}>
              <MessageSquare size={14} /> Describe your goal
            </button>
          }
        >
          Tell the assistant what you are working towards. It will read your completed courses and
          skill levels, then build a sequenced roadmap with prerequisites and milestones.
        </Empty>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>{goal.title}</h1>
          <p>{goal.blurb}</p>
        </div>
        <div className="page__head-actions">
          <button className="btn" onClick={regenerate} title="Rebuild from your current profile">
            <RefreshCw size={13} /> Regenerate
          </button>
        </div>
      </div>

      <div className="grid grid--4">
        <div className="stat">
          <span className="label">Progress</span>
          <div className="stat__value">
            {progress.done}
            <span className="stat__unit">/{progress.total}</span>
          </div>
          <Bar value={progress.done} total={progress.total} ok={progress.done === progress.total} />
        </div>
        <div className="stat">
          <span className="label">Total effort</span>
          <div className="stat__value">
            {path.totalHours}
            <span className="stat__unit">hrs</span>
          </div>
          <div className="stat__foot">{fmtHours(progress.hoursDone)} done</div>
        </div>
        <div className="stat">
          <span className="label">Estimated</span>
          <div className="stat__value">
            {path.weeks}
            <span className="stat__unit">wks</span>
          </div>
          <div className="stat__foot">at {PACE_HOURS[profile.pace]} hrs/week</div>
        </div>
        <div className="stat">
          <span className="label">Milestones</span>
          <div className="stat__value">{path.milestones.length}</div>
          <div className="stat__foot">
            ~{fmtWeeks(Math.ceil(path.weeks / path.milestones.length))} each
          </div>
        </div>
      </div>

      {path.uncovered.length > 0 && (
        <Panel title="Not fully covered by the catalogue">
          <p className="muted" style={{ fontSize: 'var(--t-md)', marginBottom: 'var(--s-3)' }}>
            The path closes most of the gap, but these skills stop short of the target. Worth
            filling with practice or an external resource.
          </p>
          <div className="row row--wrap">
            {path.uncovered.map((u) => (
              <Badge key={u.skillId} tone="warn">
                {skillName(u.skillId)} {u.from}/{u.target}
              </Badge>
            ))}
          </div>
        </Panel>
      )}

      <div className="grid grid--split">
        <div className="spine">
          {path.milestones.map((m, i) => (
            <MilestoneBlock key={m.id} milestone={m} index={i} total={path.milestones.length} />
          ))}
        </div>
        <WhyRail />
      </div>
    </div>
  )
}
