/**
 * The first thing a new account sees.
 *
 * The questionnaire is committed data (`src/lib/onboarding.ts`) and every
 * answer is applied by one pure function, so the screen is a renderer: it
 * knows how to draw four kinds of step and nothing about what the steps mean.
 *
 * Two places consult the server, and neither is load-bearing. The goal step
 * asks the extractor to resolve free text to a known goal id, falling back to
 * the keyword matcher the moment it cannot; the last step asks for a written
 * summary, falling back to the template. Answer every question with the
 * backend stopped and you still finish with a profile and a path.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check as CheckIcon, Sparkles } from 'lucide-react'
import {
  postGoalExtract,
  postOnboardingFollowup,
  postOnboardingSummary,
  type FollowupQuestion,
} from '@/lib/api'
import { skillName } from '@/lib/catalog'
import { buildPath } from '@/lib/engine'
import { getGoal, matchGoal } from '@/lib/goals'
import {
  GOAL_CHOICES,
  applyAnswers,
  ratedSkills,
  templateIntro,
  visibleSteps,
  type Answers,
  type Step,
} from '@/lib/onboarding'
import { LEVEL_LABELS, type Level } from '@/lib/types'
import { BLANK_PROFILE, useAppStore } from '@/store/useAppStore'
import { Badge, Meter, Panel } from '@/components/ui'

/** How long the goal extractor gets before the keyword matcher takes over. */
const EXTRACT_TIMEOUT_MS = 8000
const EDGE_TIMEOUT_MS = 12000

export function OnboardingRoute() {
  const profile = useAppStore((s) => s.profile)
  const completeOnboarding = useAppStore((s) => s.completeOnboarding)
  const online = useAppStore((s) => s.connection.status === 'online')
  const navigate = useNavigate()

  const [answers, setAnswers] = useState<Answers>({})
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  /** Extra questions the model thought were worth asking. Often none. */
  const [followups, setFollowups] = useState<FollowupQuestion[] | null>(null)
  const [intro, setIntro] = useState<string | null>(null)
  const [introSource, setIntroSource] = useState<'llm' | 'template'>('template')

  const steps = visibleSteps(answers)
  /** The summary is a step in the flow, drawn from the answers, not asked. */
  const total = steps.length + (followups?.length ?? 0) + 1
  const step: Step | undefined = steps[index]
  const followup = followups?.[index - steps.length]
  const onSummary = index >= steps.length + (followups?.length ?? 0)

  /**
   * What the answers are folded onto.
   *
   * Blank, except for the two things the questionnaire never asks about: the
   * name (sign-up already collected it, and an empty box would read as
   * paperwork) and the completed history, which is a record of what happened
   * rather than an opinion that can be re-answered. Everything else the
   * questionnaire covers is replaced outright, so redoing it is a genuine
   * fresh start rather than an edit over old answers.
   */
  const base = useMemo(
    () => ({ ...BLANK_PROFILE, name: profile.name, completed: profile.completed }),
    [profile.name, profile.completed],
  )

  // What the answers so far add up to. Recomputed rather than accumulated, so
  // going back and changing an answer cannot leave a stale field behind.
  const draft = useMemo(() => applyAnswers(answers, base), [answers, base])
  const preview = useMemo(() => buildPath(draft), [draft])

  function set(stepId: string, values: string[]) {
    setAnswers((current) => ({ ...current, [stepId]: values }))
  }

  function toggle(stepId: string, value: string) {
    setAnswers((current) => {
      const chosen = current[stepId] ?? []
      return {
        ...current,
        [stepId]: chosen.includes(value)
          ? chosen.filter((v) => v !== value)
          : [...chosen, value],
      }
    })
  }

  /**
   * Resolve the goal statement to one of the known tracks.
   *
   * The keyword matcher runs first and locally, so there is always an answer;
   * the extractor only ever replaces it. That ordering is what lets this step
   * advance instantly when the server is not there.
   */
  async function resolveGoal(text: string) {
    const local = matchGoal(text)
    if (local) set('goalId', [local.goal.id])

    if (!online) return
    try {
      const result = await postGoalExtract(text, draft, {
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      })
      if (result.goalId) set('goalId', [result.goalId])
    } catch {
      // The local match already stands, and the picker below covers the rest.
    }
  }

  async function next() {
    if (!step) return
    setBusy(true)
    try {
      if (step.id === 'goal') await resolveGoal(answers.goal?.[0] ?? '')

      // Last fixed step: ask whether anything is still missing before the
      // summary. An empty answer is the common one and costs a step nobody
      // has to see.
      if (index === steps.length - 1 && followups === null) {
        if (!online) setFollowups([])
        else {
          try {
            const result = await postOnboardingFollowup(
              { profile: draft, answers: asPayload(answers) },
              { signal: AbortSignal.timeout(EDGE_TIMEOUT_MS) },
            )
            setFollowups(result.questions)
          } catch {
            setFollowups([])
          }
        }
      }
      setIndex((i) => i + 1)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Write the summary when the flow arrives at it — not a step earlier, since
   * a follow-up can still change what it is a summary of. The template goes up
   * immediately and the model's version replaces it if one arrives, so the
   * screen is never waiting on the network to say something.
   */
  useEffect(() => {
    if (!onSummary || intro !== null) return

    const fallback = templateIntro(draft)
    setIntro(fallback)
    if (!online) return

    let cancelled = false
    postOnboardingSummary(
      { profile: draft, answers: asPayload(answers) },
      { signal: AbortSignal.timeout(EDGE_TIMEOUT_MS) },
    )
      .then((result) => {
        if (cancelled) return
        setIntro(result.text)
        setIntroSource(result.source)
      })
      .catch(() => {
        // The template is already on screen and is a complete answer.
      })

    return () => {
      cancelled = true
    }
    // Only the arrival matters; re-running on every keystroke would rewrite it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSummary])

  function finish() {
    completeOnboarding({ ...draft, intro: intro ?? templateIntro(draft) })
    navigate('/path')
  }

  // ---- rendering --------------------------------------------------------

  const answered = (() => {
    if (onSummary) return true
    if (followup) return (answers[followup.id] ?? []).length > 0
    if (!step) return false
    if (step.optional) return true
    return (answers[step.id] ?? []).some((value) => value.trim().length > 0)
  })()

  const goal = getGoal(draft.goalId)
  const shown = Math.min(index + 1, total)

  return (
    <div className="onb">
      <div className="onb__card">
        <div className="onb__head">
          <div>
            <span className="label">Setting up</span>
            <div className="onb__count mono">
              {shown} / {total}
            </div>
          </div>
          <div className="onb__bar">
            <span style={{ width: `${(shown / total) * 100}%` }} />
          </div>
        </div>

        {/* ---- a fixed step ---- */}
        {step && !onSummary && !followup && (
          <div className="onb__body">
            <h2 className="onb__prompt">{step.prompt}</h2>
            {step.help && <p className="onb__help">{step.help}</p>}

            {step.kind === 'text' && (
              <input
                className="input onb__input"
                autoFocus
                value={answers[step.id]?.[0] ?? (step.id === 'name' ? profile.name : '')}
                placeholder={step.placeholder}
                onChange={(e) => set(step.id, [e.target.value])}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && answered && !busy) void next()
                }}
              />
            )}

            {step.kind === 'single' && (
              <div className="onb__options">
                {(step.options ?? []).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`onb__option ${answers[step.id]?.[0] === option.id ? 'onb__option--on' : ''}`}
                    onClick={() => set(step.id, [option.id])}
                  >
                    <span className="onb__option-label">{option.label}</span>
                    {option.help && <span className="onb__option-help">{option.help}</span>}
                  </button>
                ))}
              </div>
            )}

            {step.kind === 'multi' && (
              <div className="onb__tags">
                {(step.options ?? []).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`onb__tag ${(answers[step.id] ?? []).includes(option.id) ? 'onb__tag--on' : ''}`}
                    onClick={() => toggle(step.id, option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            {step.kind === 'levels' && (
              <div className="onb__levels">
                {ratedSkills(draft.goalId).map((skillId) => {
                  const value = Number(answers[`level:${skillId}`]?.[0] ?? 0) as Level
                  return (
                    <div key={skillId} className="onb__level">
                      <div className="onb__level-head">
                        <span>{skillName(skillId)}</span>
                        <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
                          {LEVEL_LABELS[value]}
                          {goal?.target[skillId] ? ` · goal needs ${goal.target[skillId]}` : ''}
                        </span>
                      </div>
                      <div className="row" style={{ gap: 'var(--s-3)', alignItems: 'center' }}>
                        <input
                          type="range"
                          min={0}
                          max={5}
                          step={1}
                          value={value}
                          onChange={(e) => set(`level:${skillId}`, [e.target.value])}
                          aria-label={`Your level in ${skillName(skillId)}`}
                        />
                        <Meter level={value} target={goal?.target[skillId]} small />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* The extractor picks a track; this is where it is corrected. */}
            {step.id === 'goal' && draft.goalId && (
              <div className="onb__resolved">
                <span className="faint">Closest track:</span>
                <div className="onb__options onb__options--tight">
                  {GOAL_CHOICES.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      className={`onb__option ${draft.goalId === choice.id ? 'onb__option--on' : ''}`}
                      onClick={() => set('goalId', [choice.id])}
                    >
                      <span className="onb__option-label">{choice.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- a follow-up the model asked for ---- */}
        {followup && !onSummary && (
          <div className="onb__body">
            <h2 className="onb__prompt">{followup.prompt}</h2>
            <p className="onb__help">
              <Sparkles size={12} /> Asked because your answers left this open.
            </p>
            <div className="onb__tags">
              {followup.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`onb__tag ${(answers[followup.id] ?? []).includes(option.id) ? 'onb__tag--on' : ''}`}
                  onClick={() => {
                    toggle(followup.id, option.id)
                    // A follow-up writes through the same fields the fixed
                    // steps do — an interest tag, or a floor under a skill.
                    if (option.tag) toggle('interests', option.tag)
                    if (option.skillId) {
                      const key = `level:${option.skillId}`
                      const has = (answers[key]?.[0] ?? '0') !== '0'
                      set(key, [has ? '0' : '2'])
                    }
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ---- the summary ---- */}
        {onSummary && (
          <div className="onb__body">
            <h2 className="onb__prompt">Here is what I have.</h2>
            <p className="onb__intro">{intro ?? templateIntro(draft)}</p>
            {intro !== null && introSource === 'template' && online && (
              <p className="faint" style={{ fontSize: 'var(--t-sm)' }}>
                Written from your answers directly — the model was not available.
              </p>
            )}

            <div className="onb__summary">
              <Panel title="What that produces" flush>
                <div className="panel__body">
                  {preview ? (
                    <div className="stack stack--3">
                      <div className="row row--wrap" style={{ gap: 'var(--s-2)' }}>
                        <Badge tone="accent">{goal?.title ?? 'No track'}</Badge>
                        <Badge>{preview.milestones.length} milestones</Badge>
                        <Badge>{preview.totalHours} hrs</Badge>
                        <Badge>{preview.weeks} weeks</Badge>
                      </div>
                      <p className="muted" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.55 }}>
                        Every item in it will say which gap it closes. Finishing one opens a short
                        check before it counts, and a weak result re-plans the rest.
                      </p>
                    </div>
                  ) : (
                    <p className="muted">
                      No track was matched, so there is no path yet. You can describe the goal
                      again to the assistant at any point.
                    </p>
                  )}
                </div>
              </Panel>
            </div>
          </div>
        )}

        <div className="onb__foot">
          <button
            className="btn btn--ghost"
            disabled={index === 0 || busy}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            <ArrowLeft size={13} /> Back
          </button>

          {onSummary ? (
            <button className="btn btn--primary" onClick={finish}>
              <CheckIcon size={14} /> Start
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={!answered || busy}
              onClick={() => void next()}
            >
              {busy ? 'Thinking…' : 'Continue'} <ArrowRight size={13} />
            </button>
          )}
        </div>
      </div>

      <p className="onb__foot-note faint">
        {online
          ? 'Answers stay on your account. Nothing here is shared anywhere else.'
          : 'The server is not answering, so this runs entirely in your browser — the questions and the plan are the same either way.'}
      </p>
    </div>
  )
}

/** The answers, in the shape the two server edges read. */
function asPayload(answers: Answers) {
  return Object.entries(answers).map(([stepId, values]) => ({ stepId, values }))
}
