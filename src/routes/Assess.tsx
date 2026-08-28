/**
 * Skill assessment.
 *
 * This is the one screen that genuinely requires the API, and the reason is
 * worth stating rather than hiding: the answer keys never leave the server.
 * A quiz graded in the browser is a quiz whose answers were shipped to the
 * browser, so there is no local fallback here — unlike everywhere else in
 * the app, which keeps working with the backend stopped.
 *
 * The result never edits the path. It updates what we believe about the
 * learner, and the path is recomputed from that — the same rule the server
 * enforces, applied here through the store's ordinary `setSelfRated`, so
 * there is only one way a profile ever changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, ClipboardCheck, RotateCcw } from 'lucide-react'
import {
  ApiError,
  getQuiz,
  getQuizBank,
  postQuizGrade,
  type GradeResponse,
  type Mastery,
  type QuizResponse,
} from '@/lib/api'
import { skillName } from '@/lib/catalog'
import { skillGaps } from '@/lib/engine'
import { getGoal } from '@/lib/goals'
import { LEVEL_LABELS, type Level, type SkillId } from '@/lib/types'
import { useSkillLevels } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Empty, Meter, Panel } from '@/components/ui'

const VERDICT_TONE = {
  accept: 'ok',
  refresh: 'accent',
  'ask-more': 'warn',
} as const

const VERDICT_LABEL = {
  accept: 'Already at target',
  refresh: 'Keep it in the path',
  'ask-more': 'Not conclusive',
} as const

export function AssessRoute() {
  const profile = useAppStore((s) => s.profile)
  const connection = useAppStore((s) => s.connection)
  const checkConnection = useAppStore((s) => s.checkConnection)
  const setSelfRated = useAppStore((s) => s.setSelfRated)
  const levels = useSkillLevels()
  const navigate = useNavigate()
  const goal = getGoal(profile.goalId)

  const [testable, setTestable] = useState<SkillId[] | null>(null)
  const [skillId, setSkillId] = useState<SkillId | null>(null)
  const [quiz, setQuiz] = useState<QuizResponse | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<GradeResponse | null>(null)
  /** Posterior carried between rounds, so a follow-up compounds rather than restarts. */
  const [prior, setPrior] = useState<Mastery | undefined>(undefined)
  const [busy, setBusy] = useState<'items' | 'grading' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const online = connection.status === 'online'

  /**
   * Picking a skill loads questions further down the page than the picker,
   * so on anything shorter than a tall desktop window the new panel appears
   * below the fold and it looks as though the click did nothing.
   */
  const questionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!quiz || result) return
    const element = questionsRef.current
    if (!element) return

    element.scrollIntoView({ behavior: 'smooth', block: 'start' })

    // A smooth scroll is an animation, and an animation needs a compositor.
    // In a background tab, an embedded webview, or a browser that never
    // paints, the request is accepted and simply never advances — which
    // would leave the questions below the fold with no indication that the
    // click did anything. Check, and jump if it did not take.
    const settle = setTimeout(() => {
      const { top } = element.getBoundingClientRect()
      if (top < 0 || top > window.innerHeight * 0.5) {
        element.scrollIntoView({ behavior: 'auto', block: 'start' })
      }
    }, 400)

    return () => clearTimeout(settle)
  }, [quiz, result])

  useEffect(() => {
    if (!online) return
    let cancelled = false
    getQuizBank()
      .then((bank) => {
        if (!cancelled) setTestable(bank.coverage.map((entry) => entry.skillId))
      })
      .catch(() => {
        if (!cancelled) setTestable([])
      })
    return () => {
      cancelled = true
    }
  }, [online])

  // Offer the widest open gaps first — those are the levels worth measuring,
  // because they are the ones deciding what stays in the path.
  const candidates: SkillId[] = (() => {
    if (!testable) return []
    if (!goal) return testable
    const ranked = skillGaps(profile, goal, levels)
      .map((gap) => gap.skillId)
      .filter((id) => testable.includes(id))
    const rest = testable.filter((id) => !ranked.includes(id))
    return [...ranked, ...rest]
  })()

  const loadQuiz = useCallback(
    async (id: SkillId, options: { keepPrior?: boolean } = {}) => {
      setBusy('items')
      setError(null)
      setResult(null)
      setAnswers({})
      if (!options.keepPrior) setPrior(undefined)
      try {
        const next = await getQuiz(id, { count: 3 })
        setSkillId(id)
        setQuiz(next)
      } catch (e) {
        setError(
          e instanceof ApiError ? e.message : 'Could not reach the API to load questions.',
        )
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  async function submit() {
    if (!quiz || !skillId) return
    setBusy('grading')
    setError(null)
    try {
      const graded = await postQuizGrade({
        profile,
        skillId,
        answers: quiz.items.map((item) => ({ itemId: item.id, optionId: answers[item.id] })),
        prior,
        seed: quiz.seed,
      })
      setResult(graded)
      setPrior(graded.mastery)

      // Adaptation edits state; the store's regenerate re-derives the plan.
      // Nothing is committed when the result was inconclusive.
      if (graded.applied) {
        const level = graded.applied.selfRated[skillId]
        if (level !== undefined) setSelfRated(skillId, level as Level)
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API to grade this.')
    } finally {
      setBusy(null)
    }
  }

  function askMore() {
    if (!result || !skillId) return
    setQuiz((current) =>
      current ? { ...current, items: result.moreItems, requested: result.moreItems.length } : current,
    )
    setAnswers({})
    setResult(null)
  }

  // ---- offline ----------------------------------------------------------

  if (!online) {
    return (
      <div className="page">
        <Empty
          title="The assessment needs the API"
          action={
            <button className="btn btn--primary" onClick={() => void checkConnection()}>
              <RotateCcw size={14} /> Check again
            </button>
          }
        >
          This is the one screen with no offline fallback, on purpose: grading happens on the
          server because the answer keys must never be sent to the browser. Start it with{' '}
          <code>npm run server</code> — everything else in the app keeps working without it.
        </Empty>
      </div>
    )
  }

  const allAnswered = quiz ? quiz.items.every((item) => answers[item.id]) : false

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Check a skill</h1>
          <p>
            Three questions, graded on the server. The result updates your level and re-plans the
            path — it never edits the path directly.
          </p>
        </div>
      </div>

      <div className="grid grid--split">
        <div className="stack stack--4">
          {/* ---- picker ---- */}
          <Panel title="Pick a skill" flush>
            {testable === null ? (
              <div className="panel__body">
                <p className="muted">Loading the item bank…</p>
              </div>
            ) : candidates.length === 0 ? (
              <div className="panel__body">
                <p className="muted">The item bank has no questions yet.</p>
              </div>
            ) : (
              <div className="rows">
                {candidates.slice(0, 10).map((id) => {
                  const target = goal?.target[id]
                  const current = levels[id] ?? 0
                  return (
                    <div
                      key={id}
                      className={`res res--clickable ${skillId === id ? 'res--on' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => void loadQuiz(id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          void loadQuiz(id)
                        }
                      }}
                    >
                      <div className="res__main">
                        <div className="res__title">{skillName(id)}</div>
                        <div className="res__meta">
                          <span>
                            now {current}
                            {target ? ` · goal needs ${target}` : ''}
                          </span>
                        </div>
                      </div>
                      <Meter level={current as Level} target={target} small />
                    </div>
                  )
                })}
              </div>
            )}
          </Panel>

          {error && (
            <Panel>
              <p style={{ color: 'var(--danger)', fontSize: 'var(--t-md)' }}>{error}</p>
            </Panel>
          )}

          {/* ---- questions ---- */}
          {quiz && !result && (
            <div ref={questionsRef} style={{ scrollMarginTop: 'var(--s-4)' }}>
            <Panel
              title={`${quiz.skillName} — ${quiz.items.length} question${quiz.items.length === 1 ? '' : 's'}`}
              actions={
                <span className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
                  seed {quiz.seed}
                </span>
              }
            >
              <div className="stack stack--4">
                {quiz.items.map((item, index) => (
                  <div key={item.id}>
                    <div className="quiz__stem">
                      <span className="quiz__num mono">{String(index + 1).padStart(2, '0')}</span>
                      <span>{item.stem}</span>
                    </div>
                    <div className="quiz__options">
                      {item.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={`quiz__option ${answers[item.id] === option.id ? 'quiz__option--on' : ''}`}
                          onClick={() =>
                            setAnswers((current) => ({ ...current, [item.id]: option.id }))
                          }
                        >
                          <span className="quiz__key mono">{option.id}</span>
                          <span>{option.text}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="row" style={{ gap: 'var(--s-3)' }}>
                  <button
                    className="btn btn--primary"
                    disabled={!allAnswered || busy === 'grading'}
                    onClick={() => void submit()}
                  >
                    {busy === 'grading' ? 'Grading…' : 'Submit answers'}
                  </button>
                  <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>
                    {allAnswered
                      ? 'Graded on the server — the keys are not in this page.'
                      : `${quiz.items.filter((i) => answers[i.id]).length}/${quiz.items.length} answered`}
                  </span>
                </div>
              </div>
            </Panel>
            </div>
          )}

          {busy === 'items' && (
            <Panel>
              <p className="muted">Loading questions…</p>
            </Panel>
          )}

          {/* ---- result ---- */}
          {result && (
            <Panel
              title={`${result.skillName} — ${result.score.correct}/${result.score.total} correct`}
              actions={
                result.verdict ? (
                  <Badge tone={VERDICT_TONE[result.verdict.verdict]}>
                    {VERDICT_LABEL[result.verdict.verdict]}
                  </Badge>
                ) : undefined
              }
            >
              <div className="stack stack--4">
                <div className="row" style={{ gap: 'var(--s-4)', alignItems: 'center' }}>
                  <Meter
                    level={result.mastery.level}
                    target={result.target ?? undefined}
                  />
                  <div>
                    <div style={{ fontSize: 'var(--t-md)', fontWeight: 500 }}>
                      Level {result.mastery.level} — {LEVEL_LABELS[result.mastery.level]}
                    </div>
                    <div className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
                      {Math.round(result.mastery.confidence * 100)}% confident · measured, not
                      assumed
                    </div>
                  </div>
                </div>

                {result.verdict && (
                  <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
                    {result.verdict.reason}
                  </p>
                )}

                {result.notes.map((note) => (
                  <p key={note} className="faint" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5 }}>
                    {note}
                  </p>
                ))}

                {/* The server is right that more questions would settle it, but
                    it cannot know the bank has none left. Saying "one or two
                    more would settle it" and then offering none is a promise
                    the app cannot keep. */}
                {result.verdict?.verdict === 'ask-more' && result.moreItems.length === 0 && (
                  <p className="faint" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5 }}>
                    The bank has no more {result.skillName} questions to settle it, so nothing was
                    changed. Set the level yourself on the Profile screen if you already know where
                    you stand, or add items with <code>npm run author:quiz</code>.
                  </p>
                )}

                <div className="divider" />

                <div className="stack stack--3">
                  {result.details.map((detail, index) => (
                    <div key={detail.itemId} className="quiz__review">
                      <span
                        className={`quiz__mark ${detail.correct ? 'quiz__mark--ok' : 'quiz__mark--no'}`}
                      >
                        {detail.correct ? '✓' : '✕'}
                      </span>
                      <div>
                        <div style={{ fontSize: 'var(--t-sm)', fontWeight: 500 }}>
                          Question {index + 1} · difficulty {detail.difficulty}
                          {!detail.correct && ` · answer was ${detail.correctOptionId}`}
                        </div>
                        <p className="muted" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5 }}>
                          {detail.rationale}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="row" style={{ gap: 'var(--s-3)' }}>
                  {result.moreItems.length > 0 && (
                    <button className="btn btn--primary" onClick={askMore}>
                      Answer {result.moreItems.length} more <ArrowRight size={13} />
                    </button>
                  )}
                  {skillId && (
                    <button className="btn" onClick={() => void loadQuiz(skillId)}>
                      <RotateCcw size={13} /> Start over
                    </button>
                  )}
                  <button className="btn btn--ghost" onClick={() => navigate('/path')}>
                    See the updated path <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            </Panel>
          )}
        </div>

        {/* ---- rail ---- */}
        <div className="rail">
          <Panel title="How this is scored">
            <div className="stack stack--3">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
                A level is a belief, not a fact, so the server keeps a distribution over all six
                levels rather than a single number. Answering moves that distribution.
              </p>
              <div className="divider" />
              <dl className="why__kv">
                <dt>Accept</dt>
                <dd>70%+ of the belief sits at or above the target — the path drops it.</dd>
                <dt>Refresh</dt>
                <dd>30% or less — the path keeps covering it.</dd>
                <dt>Ask more</dt>
                <dd>In between. Nothing is committed; you get more questions.</dd>
              </dl>
              <div className="divider" />
              <p className="faint" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.55 }}>
                Skipping content on weak evidence is the expensive mistake — you hit a wall several
                modules later with no idea why. That is why an inconclusive result changes nothing.
              </p>
            </div>
          </Panel>

          {!goal && (
            <Panel title="No goal set">
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                You can still measure a skill, but without a goal there is no target to compare it
                against, so there is no verdict.
              </p>
              <button
                className="btn btn--sm"
                style={{ marginTop: 'var(--s-3)' }}
                onClick={() => navigate('/')}
              >
                <ClipboardCheck size={13} /> Set a goal
              </button>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
