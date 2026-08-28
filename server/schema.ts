/**
 * Request validation.
 *
 * The schemas here mirror `src/lib/types.ts`, which is the contract the UI
 * already speaks. Mirroring by hand risks drift, so each schema carries a
 * type-level assertion that its inferred output is still assignable to the
 * domain type — add a required field to `LearnerProfile` and this file stops
 * compiling until the schema catches up.
 */

import { z } from 'zod'
import type { LearnerProfile, Level } from '../src/lib/types'

/** Fails compilation when the condition is false. */
type Assert<T extends true> = T

export const LevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
])

export type _LevelConforms = Assert<z.infer<typeof LevelSchema> extends Level ? true : false>

/**
 * Every field has a default, so a caller can post `{}` and get a coherent
 * cold-start learner rather than a validation error.
 */
export const ProfileSchema = z.object({
  name: z.string().max(120).default('Learner'),
  experience: z.enum(['beginner', 'some', 'experienced']).default('some'),
  interests: z.array(z.string().max(60)).max(50).default([]),
  completed: z.array(z.string().max(120)).max(500).default([]),
  selfRated: z.record(z.string().max(120), LevelSchema).default({}),
  goalId: z.string().max(120).nullable().default(null),
  goalStatement: z.string().max(2000).default(''),
  pace: z.enum(['light', 'steady', 'intense']).default('steady'),
})

export type ProfileInput = z.infer<typeof ProfileSchema>
export type _ProfileConforms = Assert<ProfileInput extends LearnerProfile ? true : false>

const freeText = z.string().trim().min(1, 'Say something.').max(2000)

export const PathRequest = z.object({
  profile: ProfileSchema,
})

export const GoalExtractRequest = z.object({
  text: freeText,
  /** Optional: lets the extractor mention what the learner already has. */
  profile: ProfileSchema.optional(),
})

export const ChatRequest = z.object({
  text: freeText,
  profile: ProfileSchema,
})

export const NarrateRequest = z.object({
  profile: ProfileSchema,
  resourceId: z.string().min(1).max(120),
  /** `brief` is one paragraph; `coaching` adds a second-person nudge. */
  style: z.enum(['brief', 'coaching']).default('brief'),
})

export const MasterySnapshot = z.object({
  level: LevelSchema,
  confidence: z.number().min(0).max(1),
  source: z.enum(['assumed', 'verified']),
  /** Posterior over levels 0-5. Carried between rounds of questions. */
  distribution: z.array(z.number().min(0)).length(6).optional(),
})

export type MasterySnapshotInput = z.infer<typeof MasterySnapshot>

export const QuizQuery = z.object({
  count: z.coerce.number().int().min(1).max(20).default(3),
  /** Same seed, same questions — so a rehearsal is reproducible. */
  seed: z.string().max(64).optional(),
})

export const QuizGradeRequest = z.object({
  profile: ProfileSchema,
  skillId: z.string().min(1).max(120),
  answers: z
    .array(
      z.object({
        itemId: z.string().min(1).max(120),
        optionId: z.string().min(1).max(8),
      }),
    )
    .min(1)
    .max(20),
  /** Posterior from an earlier round, so a follow-up question compounds. */
  prior: MasterySnapshot.optional(),
  /** Reused when the result is inconclusive and more items are handed back. */
  seed: z.string().max(64).optional(),
})

export const SkillsRequest = z.object({
  profile: ProfileSchema,
})
