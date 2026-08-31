/**
 * The onboarding questionnaire.
 *
 * The steps are committed data, not generated: the same questions in the
 * same order every time, so a learner who signs up with the model unreachable
 * gets the identical questionnaire as one who does not. That is the rule the
 * rest of the app follows — the model works at the edges (an optional
 * follow-up, the closing summary) and never in the middle.
 *
 * Nothing here touches React or the network. `applyAnswers` is pure, which is
 * what lets the last step preview a real path before anything is committed.
 */

import { ALL_TAGS, skillName } from './catalog'
import { GOALS, getGoal } from './goals'
import {
  LEVEL_LABELS,
  PACE_LABELS,
  type LearnerProfile,
  type Level,
  type Pace,
  type SkillId,
} from './types'

export type StepKind = 'text' | 'single' | 'multi' | 'levels'

export interface StepOption {
  id: string
  label: string
  help?: string
}

export interface Step {
  id: string
  prompt: string
  help?: string
  kind: StepKind
  /** Absent on `text`, and on `levels`, which builds its rows from the goal. */
  options?: StepOption[]
  /** Skippable steps still advance; their answer is simply empty. */
  optional?: boolean
  placeholder?: string
}

/** Free text for a `text` step; option ids for everything else. */
export type Answers = Record<string, string[]>

const tagOptions: StepOption[] = ALL_TAGS.map((tag) => ({ id: tag, label: tag }))

export const STEPS: Step[] = [
  {
    id: 'name',
    kind: 'text',
    prompt: 'What should I call you?',
    help: 'Used in the plan, and nowhere else.',
    placeholder: 'Your name',
  },
  {
    id: 'goal',
    kind: 'text',
    prompt: 'What are you trying to get to?',
    help: 'A role, a project you want to build, or a skill you need for work. Plain language is fine — I will match it to a track.',
    placeholder: 'I want to move into machine learning engineering',
  },
  {
    id: 'experience',
    kind: 'single',
    prompt: 'Where are you starting from?',
    help: 'This sets the floor under every skill until something measures it properly.',
    options: [
      { id: 'beginner', label: 'New to this', help: 'Little or no exposure to the field yet.' },
      { id: 'some', label: 'Some experience', help: 'You have built or studied a few things.' },
      {
        id: 'experienced',
        label: 'Experienced',
        help: 'You work in a related area and want to move sideways or deeper.',
      },
    ],
  },
  {
    id: 'pace',
    kind: 'single',
    prompt: 'How much time can you actually give this each week?',
    help: 'Be honest — this changes the estimate, never the plan.',
    options: (['light', 'steady', 'intense'] as Pace[]).map((pace) => ({
      id: pace,
      label: PACE_LABELS[pace],
    })),
  },
  {
    id: 'interests',
    kind: 'multi',
    prompt: 'What pulls you in?',
    help: 'Anything that sounds like the work you want to be doing. These break ties between two resources that close the same gap.',
    options: tagOptions,
  },
  {
    id: 'avoid',
    kind: 'multi',
    prompt: 'And what would you rather avoid?',
    help: 'A preference, not a veto: if one of these turns out to be a prerequisite you cannot skip, it stays in the path and I will say why.',
    options: tagOptions,
    optional: true,
  },
  {
    id: 'strengths',
    kind: 'levels',
    prompt: 'Rate yourself on the skills your goal needs.',
    help: 'Rough is fine. Anything you claim here gets checked the first time you finish something that teaches it.',
    optional: true,
  },
]

/** The skills the `levels` step asks about, given the goal resolved so far. */
export function ratedSkills(goalId: string | null): SkillId[] {
  const goal = getGoal(goalId)
  if (!goal) return []
  return Object.entries(goal.target)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([skillId]) => skillId)
}

/** Steps worth showing, given what has been answered so far. */
export function visibleSteps(answers: Answers): Step[] {
  const goalId = answers.goalId?.[0] ?? null
  return STEPS.filter((step) => step.kind !== 'levels' || ratedSkills(goalId).length > 0)
}

function levelFrom(value: string | undefined): Level | null {
  if (value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 5) return null
  return Math.round(n) as Level
}

/**
 * Fold the answers into a profile.
 *
 * Pure and total: a half-finished questionnaire produces a coherent profile
 * with defaults for whatever is missing, which is what lets the final step
 * show the plan those answers actually produce.
 *
 * `goalId` is not asked directly — it is resolved from the goal statement by
 * the extractor (the model, or the keyword matcher when there is none) and
 * written back into the answers under that key.
 */
export function applyAnswers(answers: Answers, base: LearnerProfile): LearnerProfile {
  const first = (id: string) => answers[id]?.[0]?.trim() ?? ''
  const many = (id: string) => (answers[id] ?? []).filter(Boolean)

  const experience = first('experience')
  const pace = first('pace')
  const goalId = first('goalId')

  // Level answers are keyed `level:<skillId>` so the grid can grow with the
  // goal without the answer shape needing to know which skills exist.
  const selfRated: Partial<Record<SkillId, Level>> = {}
  for (const [key, values] of Object.entries(answers)) {
    if (!key.startsWith('level:')) continue
    const level = levelFrom(values[0])
    if (level !== null && level > 0) selfRated[key.slice('level:'.length)] = level
  }

  return {
    ...base,
    name: first('name') || base.name,
    experience:
      experience === 'beginner' || experience === 'some' || experience === 'experienced'
        ? experience
        : base.experience,
    pace: pace === 'light' || pace === 'steady' || pace === 'intense' ? pace : base.pace,
    interests: many('interests'),
    avoid: many('avoid'),
    goalStatement: first('goal') || base.goalStatement,
    goalId: goalId || base.goalId,
    selfRated,
  }
}

/**
 * The deterministic version of the closing summary.
 *
 * Not a stub for the model's answer — it is the answer whenever the model is
 * unavailable, over budget, or says something that fails the output check, so
 * it has to read like something a person would write.
 */
export function templateIntro(profile: LearnerProfile): string {
  const goal = getGoal(profile.goalId)
  const parts: string[] = []

  const start = {
    beginner: 'starting fresh',
    some: 'with some ground already covered',
    experienced: 'coming in experienced',
  }[profile.experience]

  parts.push(
    goal
      ? `${profile.name}, you are heading for ${goal.title}, ${start}.`
      : `${profile.name}, you are ${start}, and the destination is not pinned down yet.`,
  )

  if (profile.interests.length > 0) {
    parts.push(`You want the work to involve ${profile.interests.slice(0, 3).join(', ')}.`)
  }
  if (profile.avoid.length > 0) {
    parts.push(
      `You would rather steer clear of ${profile.avoid.slice(0, 3).join(', ')} — that only shows up when something else depends on it.`,
    )
  }

  const rated = Object.entries(profile.selfRated).filter(([, level]) => (level ?? 0) > 0)
  if (rated.length > 0) {
    const [skillId, level] = rated.sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))[0]
    parts.push(
      `You rate yourself strongest at ${skillName(skillId)} (${LEVEL_LABELS[(level ?? 0) as Level]}), so the plan starts above the introductory material there.`,
    )
  }

  parts.push(
    `At ${profile.pace} pace, everything is sequenced so nothing arrives before its prerequisites.`,
  )

  return parts.join(' ')
}

/** Goal titles, for the picker shown when the extractor is not sure. */
export const GOAL_CHOICES: StepOption[] = GOALS.map((goal) => ({
  id: goal.id,
  label: goal.title,
  help: goal.blurb,
}))
