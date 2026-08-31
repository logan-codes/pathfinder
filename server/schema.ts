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
import { MIN_PASSWORD_LENGTH } from './config'
import { safeField } from './guard'

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
 *
 * The three free-text fields run through `safeField` here rather than at
 * each use site. They are user-controlled, they are persisted, and two of
 * them reach a prompt inside the fact sheet — so the boundary is the one
 * place worth normalising and redacting them.
 */
export const ProfileSchema = z.object({
  name: z.string().max(120).default('Learner').transform((value) => safeField(value, 120)),
  experience: z.enum(['beginner', 'some', 'experienced']).default('some'),
  interests: z
    .array(z.string().max(60))
    .max(50)
    .default([])
    .transform((values) => values.map((value) => safeField(value, 60))),
  avoid: z
    .array(z.string().max(60))
    .max(50)
    .default([])
    .transform((values) => values.map((value) => safeField(value, 60))),
  completed: z.array(z.string().max(120)).max(500).default([]),
  selfRated: z.record(z.string().max(120), LevelSchema).default({}),
  goalId: z.string().max(120).nullable().default(null),
  goalStatement: z
    .string()
    .max(2000)
    .default('')
    .transform((value) => safeField(value, 2000)),
  pace: z.enum(['light', 'steady', 'intense']).default('steady'),
  /** Null until the questionnaire is finished. */
  onboardedAt: z.number().nullable().default(null),
  intro: z
    .string()
    .max(2000)
    .default('')
    .transform((value) => safeField(value, 2000)),
})

export type ProfileInput = z.infer<typeof ProfileSchema>
export type _ProfileConforms = Assert<ProfileInput extends LearnerProfile ? true : false>

const freeText = z.string().trim().min(1, 'Say something.').max(2000)

/**
 * Which vendor should answer this one call. Validated as a bare string here
 * and resolved against the registry in `providers.ts`, so an unknown or
 * unconfigured name quietly falls back to the normal chain rather than
 * failing a request. Ignored entirely when overrides are turned off.
 */
const providerChoice = z.string().max(40).optional()

export const PathRequest = z.object({
  profile: ProfileSchema,
})

export const GoalExtractRequest = z.object({
  text: freeText,
  /** Optional: lets the extractor mention what the learner already has. */
  profile: ProfileSchema.optional(),
  provider: providerChoice,
})

export const ChatRequest = z.object({
  text: freeText,
  profile: ProfileSchema,
  provider: providerChoice,
})

export const NarrateRequest = z.object({
  profile: ProfileSchema,
  resourceId: z.string().min(1).max(120),
  /** `brief` is one paragraph; `coaching` adds a second-person nudge. */
  style: z.enum(['brief', 'coaching']).default('brief'),
  provider: providerChoice,
})

/**
 * What the browser answered the questionnaire with. The steps themselves are
 * client-side data, so the server validates shape and size only — a new step
 * must not need a deploy on this side to be answerable.
 */
export const OnboardingRequest = z.object({
  profile: ProfileSchema,
  answers: z
    .array(
      z.object({
        stepId: z.string().min(1).max(60),
        values: z
          .array(z.string().max(2000))
          .max(60)
          .transform((values) => values.map((value) => safeField(value, 2000))),
      }),
    )
    .max(40)
    .default([]),
  provider: providerChoice,
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

// ---- accounts -----------------------------------------------------------

/**
 * Deliberately permissive. A real address is one that receives mail, and
 * nothing here sends any — so this rejects obvious typos and gets out of the
 * way. The regexes that try to encode RFC 5322 reject valid addresses people
 * genuinely have.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'That does not look like an email.')

/**
 * A length floor and nothing else. Composition rules push people towards
 * `Passw0rd!` and away from the long memorable strings that are actually
 * harder to guess. The upper bound exists because scrypt will happily spend
 * a second hashing a megabyte someone pasted in.
 */
const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(200)

export const RegisterRequest = z.object({
  email,
  password,
  name: z
    .string()
    .max(120)
    .default('')
    .transform((value) => safeField(value, 120)),
})

export const LoginRequest = z.object({
  email,
  /** Not `password`: an existing account may predate a raised floor. */
  password: z.string().min(1, 'Enter your password.').max(200),
})

export const AccountPatchRequest = z
  .object({
    name: z
      .string()
      .max(120)
      .transform((value) => safeField(value, 120))
      .optional(),
    email: email.optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.email !== undefined, {
    message: 'Nothing to change.',
  })

export const PasswordChangeRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
})

/**
 * Everything about a learner that is worth carrying to another browser.
 *
 * `profile` is validated strictly, because the engine reads it and a bad
 * shape there produces a bad plan. `progress` and `conversation` are checked
 * for size and rough shape only — nothing computes on them, they are replayed
 * into the UI, and over-validating a transcript is how you lose someone's
 * history to a schema change.
 */
export const StateSaveRequest = z.object({
  profile: ProfileSchema,

  /** Record<ResourceId, 'todo' | 'active' | 'done'>. */
  progress: z
    .record(z.string().max(120), z.enum(['todo', 'active', 'done']))
    .default({}),

  /**
   * The assistant transcript. Trimmed again server-side before it is stored;
   * this bound is only here so a runaway client cannot make us parse a
   * megabyte before we trim it.
   */
  conversation: z
    .array(
      z
        .object({
          id: z.string().max(64),
          role: z.enum(['user', 'assistant']),
          text: z.string().max(4000),
          at: z.number(),
        })
        // Attachments and suggestions ride along untouched — they are the
        // UI's business, and a new attachment kind must not fail a save.
        .passthrough(),
    )
    .max(400)
    .default([]),

  /**
   * What the last round of questions established, per skill. Replayed as the
   * prior on the next round, so evidence compounds across sessions.
   */
  mastery: z
    .record(
      z.string().max(120),
      z
        .object({
          level: LevelSchema,
          confidence: z.number().min(0).max(1),
          source: z.enum(['assumed', 'verified']),
          distribution: z.array(z.number().min(0)).length(6).optional(),
          at: z.number(),
        })
        .strip(),
    )
    .default({}),

  /**
   * Path changes the learner has not acknowledged yet. Shape-checked only:
   * losing somebody's highlights to a schema change is worse than storing a
   * mark the UI does not understand.
   */
  marks: z
    .record(
      z.string().max(120),
      z
        .object({
          kind: z.enum(['added', 'removed']),
          at: z.number(),
          afterResourceId: z.string().max(120).nullable(),
          title: z.string().max(240),
          note: z.string().max(400).optional(),
        })
        .strip(),
    )
    .default({}),

  /** Items ticked while the server was unreachable. */
  unverified: z.record(z.string().max(120), z.boolean()).default({}),
})
