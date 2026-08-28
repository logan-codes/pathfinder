/**
 * The catalogue, served as-is.
 *
 * These are the only endpoints a client needs to render skill names, goal
 * titles and resource cards without shipping the mock data in its bundle.
 */

import { Router } from 'express'
import { ALL_TAGS, RESOURCES, SKILLS } from '../../src/lib/catalog'
import { GOALS } from '../../src/lib/goals'
import { LEVEL_LABELS, PACE_HOURS, PACE_LABELS } from '../../src/lib/types'

export const catalogRouter = Router()

catalogRouter.get('/catalog', (_req, res) => {
  res.json({
    skills: SKILLS,
    resources: RESOURCES,
    tags: ALL_TAGS,
    levelLabels: LEVEL_LABELS,
    paceHours: PACE_HOURS,
    paceLabels: PACE_LABELS,
  })
})

catalogRouter.get('/goals', (_req, res) => {
  res.json({ goals: GOALS })
})
