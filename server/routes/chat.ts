/**
 * The conversational endpoint.
 *
 * Four steps, in this order, and the order is the whole design:
 *
 *   0. The message is screened. It is normalised, personal data is redacted,
 *      and anything trying to steer the model is marked. A crisis message
 *      stops here with a fixed answer; a steering attempt continues with the
 *      model taken out of the loop.
 *   1. The rule-based assistant answers from live engine output. This
 *      produces the facts, the attachment, and — critically — any side
 *      effect on the profile.
 *   2. If the rules could not place the message against a goal, the model
 *      is asked to pick one, from the closed set the catalogue knows.
 *   3. The model rewrites the answer in prose, given the finished facts,
 *      and the prose is checked against those facts before it is served.
 *
 * The model never decides anything in steps 1 or 3. It chooses a goal id
 * from a fixed list, and it chooses words. The plan, the ordering, the
 * numbers and the profile changes are all the engine's.
 *
 * The response is stateless: it returns the reply, the profile with the
 * reply's effects already applied, and the path recomputed from that
 * profile. Adaptation edits state and re-derives the plan; it never edits
 * the plan directly.
 */

import { Router } from 'express'
import { respond } from '../../src/lib/assistant'
import { buildPath } from '../../src/lib/engine'
import { getGoal } from '../../src/lib/goals'
import type { LearnerProfile } from '../../src/lib/types'
import { screenInput } from '../guard'
import { asyncHandler, parseBody } from '../http'
import { converse, extractGoal, llmStatus, type GoalExtraction } from '../llm'
import { ChatRequest } from '../schema'

export const chatRouter = Router()

type Effects = NonNullable<ReturnType<typeof respond>['effects']>

function applyEffects(profile: LearnerProfile, effects: Effects | undefined): LearnerProfile {
  if (!effects) return profile
  let next = profile
  if (effects.setGoal) {
    next = { ...next, goalId: effects.setGoal.goalId, goalStatement: effects.setGoal.statement }
  }
  if (effects.setPace) next = { ...next, pace: effects.setPace }
  return next
}

chatRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const { text, profile, provider } = parseBody(ChatRequest, req.body)

    // Screened once, here, and handed to both model edges. Screening twice
    // would double-count the metric and could disagree with itself.
    const screening = screenInput(text)
    const screeningReport = {
      action: screening.action,
      flags: screening.flags,
      redacted: screening.redacted,
    }

    const currentPath = buildPath(profile)

    // A crisis message is not a routing problem. No model, no plan change,
    // no attempt to be clever about it.
    if (screening.action === 'safe-response' && screening.safeResponse) {
      llmStatus.screened += 1
      res.json({
        reply: { text: screening.safeResponse, intent: 'screened' as const, suggestions: [] },
        answeredBy: 'rules',
        deterministicText: screening.safeResponse,
        extraction: null,
        profile,
        profileChanged: false,
        path: currentPath,
        screening: screeningReport,
      })
      return
    }

    // Everything downstream sees the screened text, so a redacted phone
    // number or a stripped invisible character never reaches the rules, the
    // prompt, or the profile we hand back for persistence.
    const message = screening.text

    let reply = respond(message, { profile, path: currentPath })
    let extraction: GoalExtraction | null = null

    if (reply.intent === 'unmatched') {
      // The rules gave up. All the model may decide here is which of the
      // catalogue's goal ids applies — the plan itself is still the engine's.
      extraction = await extractGoal(message, profile, { provider, screening })
      if (extraction.goalId) {
        reply = respond(message, {
          profile,
          path: currentPath,
          resolvedGoalId: extraction.goalId,
        })
      }
    } else if (reply.intent === 'pace' && !profile.goalId) {
      // "I want to be an ML engineer and I can do 8 hours a week" states two
      // things. The assistant answers the pace and returns, so without this
      // the goal in the same sentence would be dropped on the floor.
      extraction = await extractGoal(message, profile, { provider, screening })
      const goal = extraction.goalId ? getGoal(extraction.goalId) : undefined
      if (goal) {
        reply = {
          ...reply,
          text: `${reply.text} I also picked up the goal: **${goal.title}**. Building the path around it now.`,
          attachment: { type: 'path-summary' },
          effects: {
            ...reply.effects,
            setGoal: { goalId: goal.id, statement: message },
          },
        }
      }
    }

    const nextProfile = applyEffects(profile, reply.effects)
    const changed = nextProfile !== profile
    const nextPath = changed ? buildPath(nextProfile) : currentPath

    // The prose pass runs against the state *after* effects, so a message
    // that just set a goal is answered in terms of the path it produced
    // rather than the empty one it replaced.
    const answered = await converse({
      question: message,
      profile: nextProfile,
      goal: getGoal(nextProfile.goalId),
      path: nextPath,
      deterministic: reply.text,
      intent: reply.intent ?? 'unknown',
      provider,
      screening,
    })

    res.json({
      // Only the wording is the model's. The attachment, the suggestions and
      // the effects are all still the engine's.
      reply: { ...reply, text: answered.text },
      answeredBy: answered.source === 'llm' ? 'model' : 'rules',
      /** The rules' own answer, so a client can show what was rephrased. */
      deterministicText: reply.text,
      /** Which vendor wrote the wording, when one did. */
      answeredByProvider: answered.provider,
      answeredByModel: answered.model,
      /** Non-empty when a model answer was discarded by an output check. */
      violations: answered.violations,
      extraction,
      profile: nextProfile,
      profileChanged: changed,
      path: nextPath,
      screening: screeningReport,
    })
  }),
)
