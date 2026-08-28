/**
 * Domain model.
 *
 * These types are the contract between the UI and the recommendation
 * engine. When the engine moves behind a real API, only `engine.ts`
 * changes — components keep consuming exactly these shapes.
 */

export type SkillId = string
export type ResourceId = string
export type GoalId = string

/** 0 = none, 1 = aware, 2 = novice, 3 = working, 4 = strong, 5 = expert */
export type Level = 0 | 1 | 2 | 3 | 4 | 5

export const LEVEL_LABELS: Record<Level, string> = {
  0: 'None',
  1: 'Aware',
  2: 'Novice',
  3: 'Working',
  4: 'Strong',
  5: 'Expert',
}

export type SkillDomain = 'data' | 'engineering' | 'infrastructure' | 'foundations'

export interface Skill {
  id: SkillId
  name: string
  domain: SkillDomain
}

export type ResourceKind = 'course' | 'project' | 'assessment'

export interface Resource {
  id: ResourceId
  title: string
  kind: ResourceKind
  provider: string
  hours: number
  /** Difficulty band this resource is pitched at. */
  level: 1 | 2 | 3
  /** Skills taught, and the level a learner reaches by completing it. */
  teaches: Partial<Record<SkillId, Level>>
  /** Minimum levels assumed on entry. Drives prerequisite ordering. */
  requires?: Partial<Record<SkillId, Level>>
  summary: string
  /** Free-text tags used for interest matching. */
  tags?: string[]
}

export interface Goal {
  id: GoalId
  title: string
  /** What "done" looks like, per skill. */
  target: Partial<Record<SkillId, Level>>
  /** Skills that matter most; weights bias the selection ranking. */
  weights?: Partial<Record<SkillId, number>>
  blurb: string
  /** Phrases the assistant matches against free-text goal statements. */
  keywords: string[]
}

export type Pace = 'light' | 'steady' | 'intense'

export const PACE_HOURS: Record<Pace, number> = {
  light: 4,
  steady: 8,
  intense: 15,
}

export const PACE_LABELS: Record<Pace, string> = {
  light: 'Light — 4 hrs/week',
  steady: 'Steady — 8 hrs/week',
  intense: 'Intense — 15 hrs/week',
}

export interface LearnerProfile {
  name: string
  /** Self-declared starting point, used before any history exists. */
  experience: 'beginner' | 'some' | 'experienced'
  interests: string[]
  /** Resource ids the learner has already finished. */
  completed: ResourceId[]
  /** Manual overrides on top of history-derived levels. */
  selfRated: Partial<Record<SkillId, Level>>
  goalId: GoalId | null
  /** The learner's own words, kept verbatim for the assistant to quote. */
  goalStatement: string
  pace: Pace
}

/** A single reason line shown in the "why this?" panel. */
export interface Reason {
  kind: 'gap' | 'prereq' | 'interest' | 'history' | 'level' | 'goal'
  text: string
}

export interface PathItem {
  resourceId: ResourceId
  reasons: Reason[]
  /** Skills this item is included to move, with before/after levels. */
  closes: Array<{ skillId: SkillId; from: Level; to: Level }>
}

export interface Milestone {
  id: string
  title: string
  outcome: string
  items: PathItem[]
  /** Skills assumed present before starting this milestone. */
  entryRequirements: SkillId[]
}

export interface LearningPath {
  goalId: GoalId
  milestones: Milestone[]
  totalHours: number
  weeks: number
  /** Skills the catalogue could not fully cover — surfaced honestly. */
  uncovered: Array<{ skillId: SkillId; from: Level; target: Level }>
  generatedAt: number
}

export type ItemStatus = 'todo' | 'active' | 'done'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Optional structured payload rendered under the message body. */
  attachment?:
    | { type: 'path-summary' }
    | { type: 'resources'; ids: ResourceId[] }
    | { type: 'skills'; ids: SkillId[] }
  /** Quick replies offered with an assistant turn. */
  suggestions?: string[]
  /**
   * How an assistant turn was produced. Absent on user turns and on
   * messages persisted before the API existed.
   *
   *   model  — the server consulted a language model to read the goal
   *   server — the server answered from its rules and the engine
   *   local  — the API was unreachable; answered in the browser
   */
  via?: 'model' | 'server' | 'local'
  at: number
}
