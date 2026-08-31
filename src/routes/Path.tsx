import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, MessageSquare, Minus, PenLine, RefreshCw } from 'lucide-react'
import { ApiError, postNarrate } from '@/lib/api'
import { getResource, skillName } from '@/lib/catalog'
import { findPathItem, pathResourceIds } from '@/lib/engine'
import { getGoal } from '@/lib/goals'
import { hours as fmtHours, weeks as fmtWeeks } from '@/lib/format'
import {
  PACE_HOURS,
  type Milestone,
  type PathItem,
  type PathMark,
  type ResourceId,
} from '@/lib/types'
import { useProgress } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { TopicCheck } from '@/components/TopicCheck'
import { Badge, Bar, Check, Empty, KindMark, Panel } from '@/components/ui'

const REASON_MARK: Record<PathItem['reasons'][number]['kind'], string> = {
  gap: 'GAP',
  prereq: 'PRE',
  interest: 'INT',
  history: 'HIS',
  level: 'LVL',
  goal: 'OUT',
}

/**
 * A row for something the planner took out.
 *
 * It is drawn where the item used to be, dimmed and dotted, rather than
 * silently vanishing — a plan that rearranges itself while you are not
 * looking is one you stop trusting. It clears when clicked, for good.
 */
function RemovedRow({ id, mark }: { id: ResourceId; mark: PathMark }) {
  const acknowledgeMark = useAppStore((s) => s.acknowledgeMark)

  return (
    <div
      className="res res--removed"
      role="button"
      tabIndex={0}
      title="Dismiss"
      onClick={() => acknowledgeMark(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          acknowledgeMark(id)
        }
      }}
    >
      <span className="res__ghost-mark">
        <Minus size={13} />
      </span>
      <div className="res__main">
        <div className="res__title res__title--struck">{mark.title}</div>
        <div className="res__meta">
          <span>Removed from your path</span>
          {mark.note && <span>{mark.note}</span>}
        </div>
      </div>
      <div className="res__actions">
        <span className="faint" style={{ fontSize: 'var(--t-xs)' }}>
          Click to dismiss
        </span>
      </div>
    </div>
  )
}

function MilestoneBlock({
  milestone,
  index,
  total,
  ghosts,
  checking,
  onCheck,
}: {
  milestone: Milestone
  index: number
  total: number
  /** Removed items to draw after a given resource id; `''` means at the top. */
  ghosts: Map<string, Array<[ResourceId, PathMark]>>
  checking: ResourceId | null
  onCheck: (id: ResourceId) => void
}) {
  const status = useAppStore((s) => s.status)
  const marks = useAppStore((s) => s.marks)
  const unverified = useAppStore((s) => s.unverified)
  const toggleDone = useAppStore((s) => s.toggleDone)
  const acknowledgeMark = useAppStore((s) => s.acknowledgeMark)
  const online = useAppStore((s) => s.connection.status === 'online')
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
            {index === 0 &&
              (ghosts.get('') ?? []).map(([id, mark]) => (
                <RemovedRow key={`ghost-${id}`} id={id} mark={mark} />
              ))}

            {milestone.items.map((item) => {
              const resource = getResource(item.resourceId)
              if (!resource) return null
              const isDone = status[item.resourceId] === 'done'
              const isFocused = focused === item.resourceId
              const isAdded = marks[item.resourceId]?.kind === 'added'
              const isChecking = checking === item.resourceId

              /** Seeing the item is what acknowledges it. */
              function open() {
                if (isAdded) acknowledgeMark(item.resourceId)
                focusResource(isFocused ? null : item.resourceId)
              }

              return (
                <div key={item.resourceId}>
                  <div
                    className={`res res--clickable ${isDone ? 'res--done' : ''} ${isFocused ? 'res--on' : ''} ${isAdded ? 'res--added' : ''}`}
                    onClick={open}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        open()
                      }
                    }}
                  >
                    <Check
                      checked={isDone}
                      onChange={() => {
                        // Un-ticking is just a correction, so it lands at
                        // once. Ticking is a claim, and a claim gets checked —
                        // unless there is no server to check it against, in
                        // which case it is recorded as the learner's word.
                        if (isDone) toggleDone(item.resourceId)
                        else if (online) onCheck(item.resourceId)
                        else toggleDone(item.resourceId, { verified: false })
                      }}
                      label={`Mark ${resource.title} complete`}
                    />
                    <KindMark kind={resource.kind} />
                    <div className="res__main">
                      <div className="res__title">{resource.title}</div>
                      <div className="res__meta">
                        <span>{resource.provider}</span>
                        <span>{fmtHours(resource.hours)}</span>
                        <span>L{resource.level}</span>
                        {isDone && unverified[item.resourceId] && (
                          <span className="res__flag">not verified</span>
                        )}
                      </div>
                    </div>
                    <div className="res__actions">
                      {isAdded && <Badge tone="accent">New</Badge>}
                      {isChecking && <Badge tone="warn">Checking</Badge>}
                      <span
                        className="faint"
                        title="Show why this was recommended"
                        style={{ display: 'flex', alignItems: 'center' }}
                      >
                        <Info size={14} />
                      </span>
                    </div>
                  </div>

                  {(ghosts.get(item.resourceId) ?? []).map(([id, mark]) => (
                    <RemovedRow key={`ghost-${id}`} id={id} mark={mark} />
                  ))}
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
  const marks = useAppStore((s) => s.marks)
  const progress = useProgress()
  const regenerate = useAppStore((s) => s.regenerate)
  const navigate = useNavigate()
  const goal = getGoal(profile.goalId)

  /**
   * The item whose check is open. Held here rather than inside the row,
   * because a failed check re-plans, and the row it was opened from can move
   * to another milestone — which would unmount the check mid-result.
   */
  const [checking, setChecking] = useState<ResourceId | null>(null)

  // Removed items, grouped by the surviving item they used to follow. An
  // anchor that has itself since left the path falls back to the top.
  const ghosts = useMemo(() => {
    const inPath = new Set(pathResourceIds(path))
    const grouped = new Map<string, Array<[ResourceId, PathMark]>>()
    for (const [id, mark] of Object.entries(marks)) {
      if (mark.kind !== 'removed') continue
      const anchor = mark.afterResourceId && inPath.has(mark.afterResourceId) ? mark.afterResourceId : ''
      const list = grouped.get(anchor) ?? []
      list.push([id, mark])
      grouped.set(anchor, list)
    }
    return grouped
  }, [marks, path])

  const changeCount = Object.keys(marks).length

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
          <button
            className="btn"
            onClick={() => regenerate({ markChanges: true, note: 'From rebuilding the plan.' })}
            title="Rebuild from your current profile"
          >
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

      {changeCount > 0 && (
        <div className="changes">
          <span className="changes__dot" />
          <span>
            The plan changed after your last check — {changeCount}{' '}
            {changeCount === 1 ? 'item is' : 'items are'} marked below. Click each one to clear it.
          </span>
        </div>
      )}

      {checking && (
        <TopicCheck resourceId={checking} onClose={() => setChecking(null)} />
      )}

      <div className="grid grid--split">
        <div className="spine">
          {path.milestones.map((m, i) => (
            <MilestoneBlock
              key={m.id}
              milestone={m}
              index={i}
              total={path.milestones.length}
              ghosts={ghosts}
              checking={checking}
              onCheck={setChecking}
            />
          ))}
        </div>
        <WhyRail />
      </div>
    </div>
  )
}
