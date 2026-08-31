/**
 * LLM edge 1, exposed on its own: free text in, a known goal id out.
 *
 * Separate from /api/chat so the extractor can be demonstrated, tested and
 * compared against the keyword fallback in isolation. `source` always says
 * which one answered.
 */

import { Router } from 'express'
import { getGoal } from '../../src/lib/goals'
import { asyncHandler, parseBody } from '../http'
import { extractGoal } from '../llm'
import { GoalExtractRequest } from '../schema'

export const goalRouter = Router()

goalRouter.post(
  '/goal/extract',
  asyncHandler(async (req, res) => {
    const { text, profile, provider } = parseBody(GoalExtractRequest, req.body)
    const extraction = await extractGoal(text, profile, { provider })

    res.json({
      ...extraction,
      goal: extraction.goalId ? (getGoal(extraction.goalId) ?? null) : null,
    })
  }),
)
