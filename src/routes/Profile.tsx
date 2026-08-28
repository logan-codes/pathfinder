import { ALL_TAGS, RESOURCES, SKILLS, skillName } from '@/lib/catalog'
import { GOALS } from '@/lib/goals'
import { hours as fmtHours } from '@/lib/format'
import {
  LEVEL_LABELS,
  PACE_LABELS,
  type Level,
  type LearnerProfile,
  type Pace,
  type SkillDomain,
} from '@/lib/types'
import { useSkillLevels } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Check, Field, KindMark, Meter, Panel } from '@/components/ui'

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

export function ProfileRoute() {
  const profile = useAppStore((s) => s.profile)
  const levels = useSkillLevels()
  const updateProfile = useAppStore((s) => s.updateProfile)
  const toggleInterest = useAppStore((s) => s.toggleInterest)
  const toggleCompleted = useAppStore((s) => s.toggleCompleted)
  const setSelfRated = useAppStore((s) => s.setSelfRated)
  const setPace = useAppStore((s) => s.setPace)
  const setGoal = useAppStore((s) => s.setGoal)

  const byDomain = (domain: SkillDomain) => SKILLS.filter((s) => s.domain === domain)

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Profile</h1>
          <p>
            Everything the recommendation engine reads. Change anything here and the path rebuilds
            immediately — this page and the roadmap are never out of sync.
          </p>
        </div>
      </div>

      <div className="grid grid--2">
        <Panel title="Basics">
          <div className="stack stack--4">
            <Field label="Name">
              <input
                className="input"
                value={profile.name}
                onChange={(e) => updateProfile({ name: e.target.value })}
              />
            </Field>

            <Field label="Experience" hint="Sets the baseline before your history is considered.">
              <select
                className="select"
                value={profile.experience}
                onChange={(e) =>
                  updateProfile({ experience: e.target.value as LearnerProfile['experience'] })
                }
              >
                {EXPERIENCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Goal" hint="Or describe it in your own words in the assistant.">
              <select
                className="select"
                value={profile.goalId ?? ''}
                onChange={(e) => setGoal(e.target.value)}
              >
                <option value="" disabled>
                  Select a goal…
                </option>
                {GOALS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Weekly pace" hint="Drives the schedule estimate, not the content.">
              <select
                className="select"
                value={profile.pace}
                onChange={(e) => setPace(e.target.value as Pace)}
              >
                {(Object.keys(PACE_LABELS) as Pace[]).map((p) => (
                  <option key={p} value={p}>
                    {PACE_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>

            {profile.goalStatement && (
              <div className="keyline">
                <span className="label">In your words</span>
                <p className="muted" style={{ fontSize: 'var(--t-md)', marginTop: 'var(--s-1)' }}>
                  “{profile.goalStatement}”
                </p>
              </div>
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
            Used to break ties between resources that close the same skill gap.
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

      <Panel
        title="Skill levels"
        actions={
          <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
            derived from history · override below
          </span>
        }
      >
        <p className="muted" style={{ fontSize: 'var(--t-sm)', marginBottom: 'var(--s-4)' }}>
          Levels are inferred from what you have completed. Where that is wrong, set it yourself —
          a manual rating always wins if it is higher.
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
    </div>
  )
}
