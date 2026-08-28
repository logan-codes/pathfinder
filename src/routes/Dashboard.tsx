import { useNavigate } from 'react-router-dom'
import { ArrowRight, MessageSquare } from 'lucide-react'
import { getResource, skillName } from '@/lib/catalog'
import { skillGaps } from '@/lib/engine'
import { getGoal } from '@/lib/goals'
import { hours as fmtHours, pct } from '@/lib/format'
import { LEVEL_LABELS, type Level } from '@/lib/types'
import { useNextUp, useProgress, useQueue, useRecentlyCompleted, useSkillLevels } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Bar, BarChart, Empty, KindMark, Meter, Panel, Stat } from '@/components/ui'

/** Synthetic weekly activity. Real data would come from the platform's
 *  event log; the shape is what matters for the UI. */
function activityData(hoursDone: number) {
  const weeks = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']
  // Deterministic distribution so the chart does not jump between renders.
  const shape = [0.6, 1, 0.4, 1.3, 0.9, 1.5, 0.7, 1.1]
  const perWeek = hoursDone / shape.reduce((a, b) => a + b, 0)
  return weeks.map((label, i) => ({ label, value: Math.round(perWeek * shape[i]) }))
}

export function DashboardRoute() {
  const path = useAppStore((s) => s.path)
  const profile = useAppStore((s) => s.profile)
  const progress = useProgress()
  const levels = useSkillLevels()
  const status = useAppStore((s) => s.status)
  const nextUp = useNextUp()
  const queue = useQueue(4)
  const recent = useRecentlyCompleted(4)
  const toggleDone = useAppStore((s) => s.toggleDone)
  const navigate = useNavigate()

  const goal = getGoal(profile.goalId)

  if (!path || !goal) {
    return (
      <div className="page">
        <Empty
          title="Nothing to track yet"
          action={
            <button className="btn btn--primary" onClick={() => navigate('/')}>
              <MessageSquare size={14} /> Set a goal
            </button>
          }
        >
          Once you have a learning path, this page tracks completion, skill movement and what to
          pick up next.
        </Empty>
      </div>
    )
  }

  const gaps = skillGaps(profile, goal, levels)
  const atTarget = gaps.filter((g) => g.gap === 0).length
  const nextResource = nextUp ? getResource(nextUp) : null

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Dashboard</h1>
          <p>
            Tracking towards <strong>{goal.title}</strong>.
          </p>
        </div>
        <div className="page__head-actions">
          <button className="btn" onClick={() => navigate('/path')}>
            Full path <ArrowRight size={13} />
          </button>
        </div>
      </div>

      <div className="grid grid--4">
        <Stat
          label="Path complete"
          value={pct(progress.done, progress.total)}
          unit="%"
          foot={`${progress.done} of ${progress.total} items`}
        />
        <Stat
          label="Hours invested"
          value={progress.hoursDone}
          unit={`/${progress.hoursTotal}`}
          foot={`${fmtHours(progress.hoursTotal - progress.hoursDone)} remaining`}
        />
        <Stat
          label="Skills at target"
          value={atTarget}
          unit={`/${gaps.length}`}
          foot={`${gaps.length - atTarget} still short`}
        />
        <Stat
          label="Est. completion"
          value={Math.max(
            0,
            Math.ceil(((progress.hoursTotal - progress.hoursDone) / path.totalHours) * path.weeks),
          )}
          unit="wks"
          foot={`at your ${profile.pace} pace`}
        />
      </div>

      <div className="grid grid--split">
        <div className="stack stack--4">
          <Panel
            title="Skill development"
            actions={<span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>current / target</span>}
            flush
          >
            <table className="skilltable">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Level</th>
                  <th style={{ width: 120 }}>Progress</th>
                  <th style={{ width: 64, textAlign: 'right' }}>Gap</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={g.skillId}>
                    <td>{skillName(g.skillId)}</td>
                    <td className="num">{LEVEL_LABELS[g.current as Level]}</td>
                    <td>
                      <Meter level={g.current} target={g.target} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {g.gap === 0 ? (
                        <Badge tone="ok">met</Badge>
                      ) : (
                        <span className="num">+{g.gap}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Milestones">
            <div className="stack stack--4">
              {path.milestones.map((m, i) => {
                const done = m.items.filter((it) => status[it.resourceId] === 'done').length
                return (
                  <div key={m.id} className="stack stack--2">
                    <div className="row row--between">
                      <div className="row">
                        <span className="kind">{i + 1}</span>
                        <span style={{ fontWeight: 500 }}>{m.title}</span>
                      </div>
                      <span className="mono faint" style={{ fontSize: 'var(--t-xs)' }}>
                        {done}/{m.items.length}
                      </span>
                    </div>
                    <Bar value={done} total={m.items.length} ok={done === m.items.length} />
                  </div>
                )
              })}
            </div>
          </Panel>

          <Panel title="Weekly activity" actions={<span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>hrs</span>}>
            <BarChart data={activityData(progress.hoursDone)} ariaLabel="Hours studied per week" />
          </Panel>
        </div>

        <div className="stack stack--4">
          <Panel title="Next action">
            {nextResource ? (
              <div className="stack stack--3">
                <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s-3)' }}>
                  <KindMark kind={nextResource.kind} />
                  <div style={{ minWidth: 0 }}>
                    <div className="res__title">{nextResource.title}</div>
                    <div className="res__meta">
                      <span>{nextResource.provider}</span>
                      <span>{fmtHours(nextResource.hours)}</span>
                    </div>
                  </div>
                </div>
                <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>{nextResource.summary}</p>
                <div className="row">
                  <button className="btn btn--primary" onClick={() => toggleDone(nextResource.id)}>
                    Mark complete
                  </button>
                  <button className="btn" onClick={() => navigate('/path')}>
                    Why this?
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">Path complete. Set a new goal in the assistant.</p>
            )}
          </Panel>

          <Panel title="Up next" flush>
            <div className="rows">
              {queue.length === 0 && (
                <div className="rowitem">
                  <span className="muted">Nothing outstanding.</span>
                </div>
              )}
              {queue.map((item) => {
                const r = getResource(item.resourceId)
                if (!r) return null
                return (
                  <div className="res" key={item.resourceId}>
                    <KindMark kind={r.kind} />
                    <div className="res__main">
                      <div className="res__title">{r.title}</div>
                      <div className="res__meta">
                        <span>{item.milestone}</span>
                        <span>{fmtHours(r.hours)}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Panel>

          <Panel title="Recently completed" flush>
            <div className="rows">
              {progress.done === 0 && (
                <div className="rowitem">
                  <span className="muted">No items completed yet.</span>
                </div>
              )}
              {recent.map((id) => {
                const r = getResource(id)
                if (!r) return null
                return (
                  <div className="res" key={id}>
                    <KindMark kind={r.kind} />
                    <div className="res__main">
                      <div className="res__title">{r.title}</div>
                      <div className="res__meta">
                        <span>{fmtHours(r.hours)}</span>
                      </div>
                    </div>
                    <Badge tone="ok">done</Badge>
                  </div>
                )
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
