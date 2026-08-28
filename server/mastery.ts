/**
 * What the learner actually knows, and how sure we are.
 *
 * The 0-5 levels the engine consumes are a point estimate. A point estimate
 * is fine for planning and dangerous for skipping: dropping a module because
 * a learner *probably* knows it is the expensive error — they hit a wall
 * several modules later with no idea why. So mastery is tracked here as a
 * posterior over the six level buckets, and content is only skipped when
 * most of the probability mass is at or above the target.
 *
 * The model is deliberately the smallest thing that works: a prior derived
 * from whatever we assumed before, and a two-value likelihood per answered
 * item. Real IRT calibration would replace `pCorrect` and nothing else.
 */

import type { Level } from '../src/lib/types'

export const LEVEL_BUCKETS = [0, 1, 2, 3, 4, 5] as const

export type MasterySource = 'assumed' | 'verified'

export interface MasteryState {
  /** Most likely bucket. This is what the engine gets. */
  level: Level
  /** Posterior probability of that bucket, 0-1. */
  confidence: number
  /** Posterior mean — moves smoothly, good for a meter. */
  expected: number
  source: MasterySource
  /** Full posterior, so the next round of questions can build on it. */
  distribution: number[]
}

export interface GradedItem {
  /** The level this item is pitched at: answering it needs `level >= difficulty`. */
  difficulty: number
  correct: boolean
}

export type Verdict = 'accept' | 'ask-more' | 'refresh'

export interface MasteryVerdict {
  verdict: Verdict
  /** Posterior mass at or above the target level. */
  pAtOrAboveTarget: number
  reason: string
}

/**
 * How fast belief decays away from the level we assumed. History and
 * self-rating are weak evidence and get a wide prior; a previous assessment
 * gets a sharp one.
 */
const DECAY: Record<MasterySource, number> = {
  assumed: 0.62,
  verified: 0.35,
}

/** Answer an item at or below your level. */
const P_KNOWN = 0.85
/** Answer an item above your level — four options, so a little above chance. */
const P_GUESS = 0.28

/** Skip content only when this much of the posterior sits at or above target. */
const ACCEPT_THRESHOLD = 0.7
/** Below this, the learner is clearly short and the path should teach it. */
const REFRESH_THRESHOLD = 0.3

function normalise(weights: number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (!(total > 0)) return LEVEL_BUCKETS.map(() => 1 / LEVEL_BUCKETS.length)
  return weights.map((w) => w / total)
}

const round = (n: number, dp: number) => Number(n.toFixed(dp))

/** Belief before any question is asked. */
export function priorFor(level: Level, source: MasterySource): number[] {
  const decay = DECAY[source]
  return normalise(LEVEL_BUCKETS.map((bucket) => decay ** Math.abs(bucket - level)))
}

function pCorrect(level: number, difficulty: number): number {
  return level >= difficulty ? P_KNOWN : P_GUESS
}

/** One Bayesian update. Exported so the update rule is testable on its own. */
export function updateWith(distribution: number[], item: GradedItem): number[] {
  return normalise(
    distribution.map((p, level) => {
      const correct = pCorrect(level, item.difficulty)
      return p * (item.correct ? correct : 1 - correct)
    }),
  )
}

export function summarise(distribution: number[], source: MasterySource): MasteryState {
  let best = 0
  for (let i = 1; i < distribution.length; i++) {
    if (distribution[i] > distribution[best]) best = i
  }
  return {
    level: best as Level,
    confidence: round(distribution[best], 3),
    expected: round(
      distribution.reduce((sum, p, level) => sum + p * level, 0),
      2,
    ),
    source,
    distribution: distribution.map((p) => round(p, 4)),
  }
}

/**
 * Fold a round of answers into whatever we believed before.
 * `start.distribution` carries a previous round's posterior; without one we
 * build a prior from the level the profiling engine assumed.
 */
export function assess(
  start: { level: Level; source: MasterySource; distribution?: number[] },
  graded: GradedItem[],
): MasteryState {
  const opening =
    start.distribution && start.distribution.length === LEVEL_BUCKETS.length
      ? normalise(start.distribution)
      : priorFor(start.level, start.source)

  const posterior = graded.reduce(updateWith, opening)
  // Any answered item makes this measured rather than assumed.
  return summarise(posterior, graded.length > 0 ? 'verified' : start.source)
}

/** Decide what to do with the result, given what the goal needs. */
export function judge(state: MasteryState, target: Level): MasteryVerdict {
  const pAtOrAbove = round(
    state.distribution.slice(target).reduce((sum, p) => sum + p, 0),
    3,
  )

  if (pAtOrAbove >= ACCEPT_THRESHOLD) {
    return {
      verdict: 'accept',
      pAtOrAboveTarget: pAtOrAbove,
      reason: `${Math.round(pAtOrAbove * 100)}% confident you are already at level ${target} or above, so this is safe to skip.`,
    }
  }

  if (pAtOrAbove <= REFRESH_THRESHOLD) {
    return {
      verdict: 'refresh',
      pAtOrAboveTarget: pAtOrAbove,
      reason: `Only ${Math.round(pAtOrAbove * 100)}% confident you are at level ${target}, so the path should still cover it.`,
    }
  }

  return {
    verdict: 'ask-more',
    pAtOrAboveTarget: pAtOrAbove,
    reason:
      'The answers put you right on the boundary. One or two more questions would settle it — guessing here either wastes your time or skips something you need.',
  }
}
