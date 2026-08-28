/**
 * LLM edge 2: turn a computed explanation into prose.
 *
 * The reasons and the skill movements are produced by the engine before the
 * model is called, and they are returned alongside the narration so a client
 * can show both — or ignore the prose entirely and render the reasons, which
 * is what the offline path does.
 */

import { Router } from 'express'
import { getResource } from '../../src/lib/catalog'
import { buildPath, findPathItem, pathResourceIds } from '../../src/lib/engine'
import { getGoal } from '../../src/lib/goals'
import { asyncHandler, HttpError, parseBody } from '../http'
import { narrate } from '../llm'
import { NarrateRequest } from '../schema'

export const narrateRouter = Router()

narrateRouter.post(
  '/narrate',
  asyncHandler(async (req, res) => {
    const { profile, resourceId, style } = parseBody(NarrateRequest, req.body)

    const goal = getGoal(profile.goalId)
    if (!goal) {
      throw new HttpError(
        409,
        'no_goal',
        'This profile has no goal, so there is no path and nothing to narrate.',
      )
    }

    const path = buildPath(profile)
    const item = findPathItem(path, resourceId)
    const resource = getResource(resourceId)

    if (!item || !resource) {
      throw new HttpError(
        404,
        'not_in_path',
        `"${resourceId}" is not in the path generated for this profile.`,
        { inPath: pathResourceIds(path) },
      )
    }

    const order = pathResourceIds(path)
    const narration = await narrate({
      resource,
      goal,
      profile,
      reasons: item.reasons,
      closes: item.closes,
      position: { index: order.indexOf(resourceId), total: order.length },
      style,
    })

    res.json({
      resourceId,
      ...narration,
      // The facts behind the prose, so the client can show the audit trail.
      reasons: item.reasons,
      closes: item.closes,
    })
  }),
)
