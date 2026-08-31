/**
 * The check that stands between finishing a topic and it counting.
 *
 * Ticking a box is a claim. This turns it into evidence: three questions per
 * skill the resource teaches, graded on the server — the answer keys never
 * reach the browser — and the tick only lands if the measurement supports it.
 *
 * A failed check does not edit the path. It writes the measured level onto
 * the profile and the plan is recomputed from that, which is the same rule
 * `server/routes/quiz.ts` enforces on its side. The learner then sees what
 * moved, because `applyMeasuredLevel` marks the diff.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, RotateCcw, X } from 'lucide-react'
import {
  ApiError,
  getQuiz,
  getQuizBank,
  postQuizGrade,
  type GradeResponse,
  type Mastery,
  type QuizItem,
  type QuizResponse,
} from '@/lib/api'
import { getResource, skillName } from '@/lib/catalog'
import { checkableSkills } from '@/lib/engine'
import { getGoal } from '@/lib/goals'
import { LEVEL_LABELS, type ResourceId, type SkillId } from '@/lib/types'
import { useAppStore } from '@/store/useAppStore'
import { Badge, Meter } from '@/components/ui'

/** Questions per skill. Enough to move a belief, short enough to answer. */
const QUESTIONS = 3

/**
 * Which skills the bank can test, fetched once per page load.
 *
 * The bank does not change while the app is open, and every row in the path
 * would otherwise ask for it the moment it is opened.
 */
let bankPromise: Promise<SkillId[]> | null = null

function bankSkills(): Promise<SkillId[]> {
  if (!bankPromise) {
    bankPromise = getQuizBank()
      .then((bank) => bank.coverage.map((entry) => entry.skillId))
      .catch(() => {
        bankPromise = null // a failed load must not be cached forever
        return []
      })
  }
  return bankPromise
}

/**
 * The bar for one skill: the level this resource claims to teach, less one.
 *
 * Less one because the resource is the thing that was just finished — asking
 * a learner to already be at the level it takes them to would fail everyone.
 * What the check is really looking for is the learner who is not close.
 */
function passes(result: GradeResponse, resourceId: ResourceId): boolean {
  const taught = getResource(resourceId)?.teaches[result.skillId] ?? 0
  if (result.mastery.level >= Math.max(0, taught - 1)) return true

  // The bank ran out of questions before the posterior settled. Falling back
  // to the raw score is weaker evidence than the model, but refusing the tick
  // over a question that was never asked is worse.
  if (result.verdict?.verdict === 'ask-more' && result.moreItems.length === 0) {
    return result.score.correct / Math.max(1, result.score.total) >= 0.6
  }
  return false
}

/**
 * The store's record of a skill, in the shape the grader wants back.
 *
 * A stored distribution is only sent when it is the full six buckets the
 * server's schema expects — an older or truncated one is dropped rather than
 * rejected at the boundary, and the grader rebuilds a prior from the level.
 */
function priorFor(
  skillId: SkillId,
  mastery: ReturnType<typeof useAppStore.getState>['mastery'],
): Mastery | undefined {
  const record = mastery[skillId]
  if (!record) return undefined

  const distribution = record.distribution?.length === 6 ? record.distribution : undefined
  return {
    level: record.level,
    confidence: record.confidence,
    expected: record.level,
    source: record.source,
    ...(distribution ? { distribution } : {}),
  } as Mastery
}

export function TopicCheck({
  resourceId,
  mode = 'gate',
  onClose,
}: {
  resourceId: ResourceId
  /**
   * `gate` — the learner is claiming they finished this, and the tick waits
   * on the result. `drill` — they are proving a skill they already have, so
   * nothing is marked complete; a pass raises the level and re-plans, which
   * is how you skip content you do not need.
   */
  mode?: 'gate' | 'drill'
  onClose: () => void
}) {
  const profile = useAppStore((s) => s.profile)
  const storedMastery = useAppStore((s) => s.mastery)
  const toggleDone = useAppStore((s) => s.toggleDone)
  const recordMastery = useAppStore((s) => s.recordMastery)
  const applyMeasuredLevel = useAppStore((s) => s.applyMeasuredLevel)

  const resource = getResource(resourceId)
  const goal = getGoal(profile.goalId)

  /** The skills still to be checked. The head of it is the current one. */
  const [queue, setQueue] = useState<SkillId[] | null>(null)
  const [quiz, setQuiz] = useState<QuizResponse | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<GradeResponse | null>(null)
  const [outcome, setOutcome] = useState<'pass' | 'fail' | null>(null)
  const [busy, setBusy] = useState<'items' | 'grading' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const panel = useRef<HTMLDivElement>(null)

  const loadFor = useCallback(async (skillId: SkillId, items?: QuizItem[]) => {
    setAnswers({})
    setResult(null)
    if (items) {
      // The grader handed back more questions on the same skill; reuse them
      // rather than asking for a fresh set the posterior cannot build on.
      setQuiz((current) =>
        current ? { ...current, items, requested: items.length } : current,
      )
      return
    }
    setBusy('items')
    setError(null)
    try {
      setQuiz(await getQuiz(skillId, { count: QUESTIONS }))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the questions.')
    } finally {
      setBusy(null)
    }
  }, [])

  // Work out what this resource can be checked on, then open on the first.
  useEffect(() => {
    let cancelled = false
    void bankSkills().then((skills) => {
      if (cancelled) return
      const checkable = checkableSkills(resourceId, skills, goal ?? null)
      setQueue(checkable)
      if (checkable.length > 0) void loadFor(checkable[0])
    })
    return () => {
      cancelled = true
    }
    // Re-running this on a goal change would restart a check in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId])

  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [outcome])

  /** Nothing in the bank covers this one — accept the tick, and say so. */
  function markUnchecked() {
    toggleDone(resourceId, { verified: false })
    onClose()
  }

  async function submit() {
    const skillId = queue?.[0]
    if (!quiz || !skillId) return

    setBusy('grading')
    setError(null)
    try {
      const graded = await postQuizGrade({
        profile,
        skillId,
        answers: quiz.items.map((item) => ({ itemId: item.id, optionId: answers[item.id] })),
        prior: priorFor(skillId, storedMastery),
        seed: quiz.seed,
      })

      setResult(graded)
      recordMastery(skillId, {
        level: graded.mastery.level,
        confidence: graded.mastery.confidence,
        source: graded.mastery.source,
        distribution: graded.mastery.distribution,
        at: Date.now(),
      })

      // Inconclusive and there are more questions: settle it before deciding.
      if (graded.verdict?.verdict === 'ask-more' && graded.moreItems.length > 0) return

      if (!passes(graded, resourceId)) {
        setOutcome('fail')
        applyMeasuredLevel(
          skillId,
          graded.mastery.level,
          `${skillName(skillId)} measured at ${graded.mastery.level} after ${resource?.title ?? 'a check'}.`,
        )
        return
      }

      // A drill is the learner proving something they already have, so the
      // measured level goes on the profile and the plan is rebuilt around it.
      // A gate must not: re-planning while ticking an item off would delete
      // the very row being ticked, since a completed item leaves the path.
      if (mode === 'drill' && graded.mastery.level > (graded.before.level ?? 0)) {
        applyMeasuredLevel(
          skillId,
          graded.mastery.level,
          `${skillName(skillId)} measured at ${graded.mastery.level}.`,
        )
      }

      // Passed this skill. Either move to the next one, or the tick lands.
      const rest = queue.slice(1)
      if (rest.length > 0) {
        setQueue(rest)
        void loadFor(rest[0])
        return
      }
      setOutcome('pass')
      if (mode === 'gate') toggleDone(resourceId)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not grade that.')
    } finally {
      setBusy(null)
    }
  }

  if (!resource) return null

  const skillId = queue?.[0] ?? null
  const allAnswered = quiz ? quiz.items.every((item) => answers[item.id]) : false
  const askingMore = result?.verdict?.verdict === 'ask-more' && result.moreItems.length > 0

  return (
    <div className="tcheck" ref={panel}>
      <div className="tcheck__head">
        <div>
          <span className="label">{mode === 'gate' ? 'Before this counts' : 'Prove it and skip it'}</span>
          <div className="tcheck__title">
            {queue === null
              ? 'Finding what to ask…'
              : queue.length === 0
                ? 'Nothing to check'
                : `${skillName(skillId!)}${queue.length > 1 ? ` · ${queue.length} skills to go` : ''}`}
          </div>
        </div>
        <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close the check">
          <X size={15} />
        </button>
      </div>

      {queue !== null && queue.length === 0 && (
        <div className="tcheck__body">
          <p className="muted">
            The item bank has no questions for what {resource.title} teaches, so there is nothing
            to measure against.{mode === 'gate' ? ' Ticking it records your word for it.' : ''}
          </p>
          <div className="row" style={{ gap: 'var(--s-3)', marginTop: 'var(--s-3)' }}>
            {mode === 'gate' && (
              <button className="btn btn--primary" onClick={markUnchecked}>
                Mark it done anyway
              </button>
            )}
            <button className="btn btn--ghost" onClick={onClose}>
              {mode === 'gate' ? 'Not yet' : 'Close'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="tcheck__body">
          <p style={{ color: 'var(--danger)', fontSize: 'var(--t-md)' }}>{error}</p>
          <div className="row" style={{ gap: 'var(--s-3)', marginTop: 'var(--s-3)' }}>
            {skillId && (
              <button className="btn" onClick={() => void loadFor(skillId)}>
                <RotateCcw size={13} /> Try again
              </button>
            )}
            {mode === 'gate' && (
              <button className="btn btn--ghost" onClick={markUnchecked}>
                Tick it without checking
              </button>
            )}
          </div>
        </div>
      )}

      {busy === 'items' && (
        <div className="tcheck__body">
          <p className="muted">Loading questions…</p>
        </div>
      )}

      {/* ---- questions ---- */}
      {quiz && !outcome && !askingMore && busy !== 'items' && (
        <div className="tcheck__body">
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
                      onClick={() => setAnswers((c) => ({ ...c, [item.id]: option.id }))}
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
                {busy === 'grading' ? 'Grading…' : 'Submit'}
              </button>
              <span className="faint" style={{ fontSize: 'var(--t-sm)' }}>
                {allAnswered
                  ? 'Graded on the server — the keys are not in this page.'
                  : `${quiz.items.filter((i) => answers[i.id]).length}/${quiz.items.length} answered`}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ---- inconclusive ---- */}
      {askingMore && result && (
        <div className="tcheck__body">
          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
            {result.score.correct}/{result.score.total} — {result.verdict?.reason}
          </p>
          <div className="row" style={{ gap: 'var(--s-3)', marginTop: 'var(--s-3)' }}>
            <button
              className="btn btn--primary"
              onClick={() => void loadFor(result.skillId, result.moreItems)}
            >
              Answer {result.moreItems.length} more <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}

      {/* ---- outcome ---- */}
      {outcome && result && (
        <div className="tcheck__body">
          <div className="row" style={{ gap: 'var(--s-4)', alignItems: 'center' }}>
            <Meter level={result.mastery.level} target={result.target ?? undefined} />
            <div>
              <div className="row" style={{ gap: 'var(--s-2)', alignItems: 'center' }}>
                <Badge tone={outcome === 'pass' ? 'ok' : 'warn'}>
                  {outcome === 'pass'
                    ? mode === 'gate'
                      ? 'Marked complete'
                      : 'Level raised'
                    : 'Not yet'}
                </Badge>
                <span style={{ fontSize: 'var(--t-md)', fontWeight: 500 }}>
                  {result.score.correct}/{result.score.total} · {skillName(result.skillId)}{' '}
                  {LEVEL_LABELS[result.mastery.level]}
                </span>
              </div>
              <div className="faint mono" style={{ fontSize: 'var(--t-xs)' }}>
                {Math.round(result.mastery.confidence * 100)}% confident · measured, not assumed
              </div>
            </div>
          </div>

          <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.6, marginTop: 'var(--s-3)' }}>
            {outcome === 'pass'
              ? mode === 'gate'
                ? 'That holds up. Nothing in the plan changed.'
                : 'That holds up, so the level went up and the plan no longer covers ground you already have.'
              : mode === 'gate'
                ? 'That is below what the plan assumed, so it stays open and the path has been rebuilt around the gap. The changes are highlighted below until you click them.'
                : 'That is below the level the plan assumed, so the path has been rebuilt around the gap. The changes are highlighted until you click them.'}
          </p>

          <div className="stack stack--3" style={{ marginTop: 'var(--s-3)' }}>
            {result.details
              .filter((detail) => !detail.correct)
              .map((detail, index) => (
                <div key={detail.itemId} className="quiz__review">
                  <span className="quiz__mark quiz__mark--no">✕</span>
                  <div>
                    <div style={{ fontSize: 'var(--t-sm)', fontWeight: 500 }}>
                      Missed {index + 1} · answer was {detail.correctOptionId}
                    </div>
                    <p className="muted" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5 }}>
                      {detail.rationale}
                    </p>
                  </div>
                </div>
              ))}
          </div>

          <div className="row" style={{ gap: 'var(--s-3)', marginTop: 'var(--s-3)' }}>
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
            {outcome === 'fail' && skillId && (
              <button
                className="btn"
                onClick={() => {
                  setOutcome(null)
                  void loadFor(skillId)
                }}
              >
                <RotateCcw size={13} /> Try again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
