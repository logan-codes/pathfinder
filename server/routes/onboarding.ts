/**
 * LLM edges 4 and 5: the two model-shaped parts of onboarding.
 *
 * The questionnaire itself is not here and never reaches the server — it is
 * committed data in `src/lib/onboarding.ts`, identical for every learner,
 * answered entirely in the browser. What these two routes add is a follow-up
 * when the fixed steps left something ambiguous, and the closing summary.
 *
 * Both degrade to something usable: no follow-ups at all, and the template
 * summary. A learner who signs up with the model unreachable gets the same
 * questionnaire and the same plan — only slightly plainer prose.
 */

import { Router } from 'express'
import { asyncHandler, parseBody } from '../http.js'
import { onboardingFollowup, onboardingIntro } from '../llm.js'
import { OnboardingRequest } from '../schema.js'

export const onboardingRouter = Router()

onboardingRouter.post(
  '/onboarding/followup',
  asyncHandler(async (req, res) => {
    const { profile, answers, provider } = parseBody(OnboardingRequest, req.body)
    res.json(await onboardingFollowup(profile, answers, { provider }))
  }),
)

onboardingRouter.post(
  '/onboarding/summary',
  asyncHandler(async (req, res) => {
    const { profile, answers, provider } = parseBody(OnboardingRequest, req.body)
    res.json(await onboardingIntro(profile, answers, { provider }))
  }),
)
