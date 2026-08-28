/**
 * Typed client for the Pathfinder API (`server/`).
 *
 * Used by `store/useAppStore.ts` (paths and chat turns) and by the Path
 * screen's explanation rail (prose). Every one of those calls has a local
 * fallback, so this module failing degrades the app rather than breaking it
 * — see the store for where that policy lives.
 *
 * The dev server and `vite preview` both proxy `/api` to the backend (see
 * `vite.config.ts`), so the default base needs no configuration. Call
 * `setApiBase()` only when the API lives on another origin.
 *
 * Everything thrown from here is an `ApiError`, including responses that
 * never reached the API at all.
 */

import type { AssistantReply } from './assistant'
import type { SkillGap } from './engine'
import type {
  Goal,
  LearnerProfile,
  LearningPath,
  Level,
  PathItem,
  Reason,
  Resource,
  Skill,
  SkillId,
} from './types'

let base = '/api'

/** Point the client at another origin, e.g. in a deployed build. */
export function setApiBase(next: string): void {
  base = next.replace(/\/+$/, '')
}

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function request<T>(
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  let payload: unknown = null

  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      // Something other than the API answered — a dev proxy, a gateway, a
      // login page. Turn it into an ApiError so every caller still has one
      // error type to handle instead of a stray SyntaxError.
      throw new ApiError(
        response.status,
        'bad_response',
        `Expected JSON from the API but got a ${response.status} with a non-JSON body.`,
      )
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error
    throw new ApiError(
      response.status,
      // No envelope means the API did not produce this response.
      error?.code ?? (response.status >= 500 ? 'upstream_error' : 'http_error'),
      error?.message ?? `Request failed with ${response.status}`,
      error?.details,
    )
  }

  return payload as T
}

// ---- catalogue ----------------------------------------------------------

export interface CatalogResponse {
  skills: Skill[]
  resources: Resource[]
  tags: string[]
  levelLabels: Record<Level, string>
  paceHours: Record<LearnerProfile['pace'], number>
  paceLabels: Record<LearnerProfile['pace'], string>
}

export const getCatalog = (signal?: AbortSignal) =>
  request<CatalogResponse>('GET', '/catalog', undefined, signal)

export const getGoals = (signal?: AbortSignal) =>
  request<{ goals: Goal[] }>('GET', '/goals', undefined, signal)

// ---- the deterministic engine ------------------------------------------

export interface PathResponse {
  path: LearningPath | null
  goal?: Goal
  levels: Record<SkillId, Level>
  gaps: SkillGap[]
  weeklyHours?: number
  reason?: string
}

export const postPath = (profile: LearnerProfile, signal?: AbortSignal) =>
  request<PathResponse>('POST', '/path', { profile }, signal)

export const postProfileSkills = (profile: LearnerProfile, signal?: AbortSignal) =>
  request<{ levels: Record<SkillId, Level>; goalId: string | null; gaps: SkillGap[] }>(
    'POST',
    '/profile/skills',
    { profile },
    signal,
  )

// ---- the two LLM edges --------------------------------------------------

export interface GoalExtraction {
  goalId: string | null
  confidence: number
  restatement: string | null
  signals: string[]
  weeklyHours: number | null
  /** `keywords` means the model was unavailable, unsure, or overruled. */
  source: 'llm' | 'keywords'
  degraded: boolean
  goal: Goal | null
}

export const postGoalExtract = (
  text: string,
  profile?: LearnerProfile,
  signal?: AbortSignal,
) => request<GoalExtraction>('POST', '/goal/extract', { text, profile }, signal)

export interface ChatResponse {
  reply: AssistantReply
  /** Who wrote the words. `rules` means the model was unavailable or wrong. */
  answeredBy: 'model' | 'rules'
  /** The rule-based answer the model was asked to rephrase. */
  deterministicText: string
  /** Non-null only when the model was asked to resolve a goal. */
  extraction: Omit<GoalExtraction, 'goal'> | null
  /** The profile with the reply's effects already applied. */
  profile: LearnerProfile
  profileChanged: boolean
  path: LearningPath | null
}

export const postChat = (text: string, profile: LearnerProfile, signal?: AbortSignal) =>
  request<ChatResponse>('POST', '/chat', { text, profile }, signal)

export interface NarrationResponse {
  resourceId: string
  text: string
  /** `template` means the deterministic explanation, verbatim. */
  source: 'llm' | 'template'
  degraded: boolean
  reasons: Reason[]
  closes: PathItem['closes']
}

export const postNarrate = (
  profile: LearnerProfile,
  resourceId: string,
  style: 'brief' | 'coaching' = 'brief',
  signal?: AbortSignal,
) => request<NarrationResponse>('POST', '/narrate', { profile, resourceId, style }, signal)

// ---- assessment ---------------------------------------------------------

export interface QuizItem {
  id: string
  skillId: SkillId
  difficulty: number
  stem: string
  options: Array<{ id: string; text: string }>
}

export interface QuizBankResponse {
  bank: {
    version: number
    authoredAt: string | null
    authoredBy: string | null
    items: number
    skills: SkillId[]
    unreviewed: string[]
  }
  coverage: Array<{ skillId: SkillId; items: number }>
}

/** Which skills the item bank can actually test, and how deeply. */
export const getQuizBank = (signal?: AbortSignal) =>
  request<QuizBankResponse>('GET', '/quiz', undefined, signal)

export interface QuizResponse {
  skillId: SkillId
  skillName: string
  /** Send this back to reproduce the same questions. */
  seed: string
  requested: number
  items: QuizItem[]
}

export const getQuiz = (
  skillId: SkillId,
  options: { count?: number; seed?: string } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams()
  if (options.count !== undefined) query.set('count', String(options.count))
  if (options.seed !== undefined) query.set('seed', options.seed)
  const suffix = query.size > 0 ? `?${query}` : ''
  return request<QuizResponse>('GET', `/quiz/${encodeURIComponent(skillId)}${suffix}`, undefined, signal)
}

export interface Mastery {
  level: Level
  /** Posterior probability of that level, 0-1. */
  confidence: number
  /** Posterior mean. Moves smoothly, so it suits a meter. */
  expected: number
  source: 'assumed' | 'verified'
  distribution: number[]
}

export interface GradeResponse {
  skillId: SkillId
  skillName: string
  score: { correct: number; total: number }
  details: Array<{
    itemId: string
    difficulty: number
    correct: boolean
    chosenOptionId: string
    correctOptionId: string
    rationale: string
  }>
  before: { level: Level; source: 'assumed' | 'verified' }
  mastery: Mastery
  target: Level | null
  verdict: {
    verdict: 'accept' | 'ask-more' | 'refresh'
    pAtOrAboveTarget: number
    reason: string
  } | null
  /** Null when the result was inconclusive and nothing was committed. */
  applied: { selfRated: Record<SkillId, Level> } | null
  /** What the planner will actually use, which history can hold higher. */
  effectiveLevel: Level
  notes: string[]
  profile: LearnerProfile
  /** Recomputed from the updated profile, never edited in place. */
  path: LearningPath | null
  /** Non-empty when the verdict is `ask-more`. */
  moreItems: QuizItem[]
}

export const postQuizGrade = (
  payload: {
    profile: LearnerProfile
    skillId: SkillId
    answers: Array<{ itemId: string; optionId: string }>
    prior?: Mastery
    seed?: string
  },
  signal?: AbortSignal,
) => request<GradeResponse>('POST', '/quiz/grade', payload, signal)

// ---- diagnostics --------------------------------------------------------

export interface HealthResponse {
  ok: boolean
  uptimeSeconds: number
  llm: {
    enabled: boolean
    mode: 'auto' | 'on' | 'off'
    model: string
    calls: number
    fallbacks: number
    lastError: string | null
    lastErrorAt: number | null
    timeoutMs: number
    refusalFallbacks: boolean
  }
  catalog: { skills: number; resources: number; goals: number }
  quiz: {
    version: number
    items: number
    skills: string[]
    unreviewed: string[]
  }
}

export const getHealth = (signal?: AbortSignal) =>
  request<HealthResponse>('GET', '/health', undefined, signal)
