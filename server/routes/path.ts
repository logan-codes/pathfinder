/**
 * Path generation and profiling — the deterministic core, over HTTP.
 *
 * No model is involved in anything here. Same profile in, same path out,
 * every time, with or without a network connection.
 */

import { Router } from 'express'
import { buildPath, profileSkills, skillGaps } from '../../src/lib/engine.js'
import { getGoal } from '../../src/lib/goals.js'
import { PACE_HOURS } from '../../src/lib/types.js'
import { parseBody } from '../http.js'
import { PathRequest, SkillsRequest } from '../schema.js'

export const pathRouter = Router()

/**
 * POST /api/path — the whole plan for a learner profile.
 *
 * A profile with no goal is a normal state, not an error: the response is
 * 200 with `path: null` and a reason, so the client can render the empty
 * state without special-casing a status code.
 */
pathRouter.post('/path', (req, res) => {
  const { profile } = parseBody(PathRequest, req.body)
  const goal = getGoal(profile.goalId)

  if (!goal) {
    res.json({
      path: null,
      reason: profile.goalId
        ? `No goal template with id "${profile.goalId}".`
        : 'No goal set yet.',
      levels: profileSkills(profile),
      gaps: [],
    })
    return
  }

  const levels = profileSkills(profile)
  const path = buildPath(profile)

  res.json({
    path,
    goal,
    levels,
    gaps: skillGaps(profile, goal, levels),
    weeklyHours: PACE_HOURS[profile.pace],
  })
})

/**
 * POST /api/profile/skills — what the learner knows right now, and how far
 * that is from the goal. Useful on its own for the profile screen.
 */
pathRouter.post('/profile/skills', (req, res) => {
  const { profile } = parseBody(SkillsRequest, req.body)
  const levels = profileSkills(profile)
  const goal = getGoal(profile.goalId)

  res.json({
    levels,
    goalId: goal?.id ?? null,
    gaps: goal ? skillGaps(profile, goal, levels) : [],
  })
})
