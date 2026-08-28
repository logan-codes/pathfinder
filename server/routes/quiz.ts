/**
 * Assessment: ask, grade, update belief, re-plan.
 *
 * The important rule lives at the end of the grade handler. A result never
 * edits the path. It edits what we believe about the learner, and the path
 * is then recomputed from that belief. Editing the path directly accumulates
 * inconsistency until the "why this?" explanations start lying, which would
 * cost the feature that justifies the whole architecture.
 *
 * The second rule is that a skip needs evidence. When the posterior sits on
 * the boundary, the response hands back more questions instead of a decision.
 */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { skillName } from '../../src/lib/catalog'
import { buildPath, profileSkills } from '../../src/lib/engine'
import { getGoal } from '../../src/lib/goals'
import type { Level } from '../../src/lib/types'
import { HttpError, parseBody, parseQuery } from '../http'
import { assess, judge } from '../mastery'
import { bankMeta, coverage, gradeAnswers, hasSkill, itemsForSkill } from '../quiz'
import { QuizGradeRequest, QuizQuery } from '../schema'

export const quizRouter = Router()

const newSeed = () => randomUUID().slice(0, 8)

quizRouter.get('/quiz', (_req, res) => {
  res.json({ bank: bankMeta, coverage: coverage() })
})

/**
 * GET /api/quiz/:skillId — questions, without their answers.
 *
 * The seed is echoed back. Reusing it reproduces the same questions, which
 * is what makes a rehearsal repeatable and two learners comparable.
 */
quizRouter.get('/quiz/:skillId', (req, res) => {
  const { skillId } = req.params
  const { count, seed } = parseQuery(QuizQuery, req.query)

  if (!hasSkill(skillId)) {
    throw new HttpError(
      404,
      'no_items',
      `The item bank has no questions for "${skillId}".`,
      { skillsWithItems: bankMeta.skills },
    )
  }

  const resolvedSeed = seed ?? newSeed()
  const items = itemsForSkill(skillId, { count, seed: resolvedSeed })

  res.json({
    skillId,
    skillName: skillName(skillId),
    seed: resolvedSeed,
    requested: count,
    items,
  })
})

/**
 * POST /api/quiz/grade — grade a round and re-derive everything from it.
 */
quizRouter.post('/quiz/grade', (req, res) => {
  const { profile, skillId, answers, prior, seed } = parseBody(QuizGradeRequest, req.body)

  if (!hasSkill(skillId)) {
    throw new HttpError(404, 'no_items', `The item bank has no questions for "${skillId}".`, {
      skillsWithItems: bankMeta.skills,
    })
  }

  const { details, graded, rejected } = gradeAnswers(skillId, answers)
  if (rejected.length > 0) {
    throw new HttpError(
      400,
      'unknown_items',
      'Some answers refer to items that are not in the bank for this skill.',
      { rejected },
    )
  }

  const levels = profileSkills(profile)
  const before = {
    level: (levels[skillId] ?? 0) as Level,
    source: prior?.source ?? ('assumed' as const),
    distribution: prior?.distribution,
  }

  const mastery = assess(before, graded)

  const goal = getGoal(profile.goalId)
  const target = (goal?.target[skillId] ?? null) as Level | null
  const verdict = target === null ? null : judge(mastery, target)

  // An inconclusive result is not a licence to change the plan. Ask again.
  const inconclusive = verdict?.verdict === 'ask-more'
  const nextProfile = inconclusive
    ? profile
    : { ...profile, selfRated: { ...profile.selfRated, [skillId]: mastery.level } }

  const effectiveLevel = (profileSkills(nextProfile)[skillId] ?? 0) as Level
  const notes: string[] = []

  if (target === null) {
    notes.push(
      goal
        ? `"${goal.title}" does not target ${skillName(skillId)}, so there is nothing to compare the result against.`
        : 'No goal is set, so the result is recorded but there is no target to judge it against.',
    )
  }

  // `profileSkills` takes the strongest evidence for a skill, so a completed
  // course can hold a level above a weaker measurement. Say so rather than
  // reporting a number the engine will not actually use.
  if (!inconclusive && effectiveLevel > mastery.level) {
    notes.push(
      `Measured ${skillName(skillId)} at ${mastery.level}, but completed resources already imply ${effectiveLevel}, and history is treated as the stronger evidence. The planner will use ${effectiveLevel}.`,
    )
  }

  res.json({
    skillId,
    skillName: skillName(skillId),
    score: { correct: details.filter((d) => d.correct).length, total: details.length },
    details,
    before: { level: before.level, source: before.source },
    mastery,
    target,
    verdict,
    applied: inconclusive ? null : { selfRated: { [skillId]: mastery.level } },
    effectiveLevel,
    notes,
    profile: nextProfile,
    // Recomputed from the edited state — never edited directly.
    path: buildPath(nextProfile),
    moreItems: inconclusive
      ? itemsForSkill(skillId, {
          count: 2,
          seed: seed ?? newSeed(),
          exclude: answers.map((answer) => answer.itemId),
        })
      : [],
  })
})
