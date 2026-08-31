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

import type { AssistantReply } from './assistant.js'
import type { SkillGap } from './engine.js'
import type {
  ChatMessage,
  Goal,
  ItemStatus,
  LearnerProfile,
  LearningPath,
  Level,
  MasteryRecord,
  PathItem,
  PathMark,
  Reason,
  Resource,
  Skill,
  SkillId,
} from './types.js'

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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method,
    signal,
    // The session lives in an httpOnly cookie, so it is never readable from
    // here — the browser has to be told to attach it.
    credentials: 'include',
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

// ---- accounts -----------------------------------------------------------
//
// Sign-in is optional everywhere in this app. What an account buys is one
// profile across two browsers; everything else works signed out, because the
// planning routes are stateless and the engine also runs locally.
//
// Identity is Supabase Auth, behind the API. Tokens never reach this bundle:
// the server keeps them in httpOnly cookies, so there is nothing here for an
// injected script to read.

export interface AccountUser {
  id: string
  email: string
  name: string
  createdAt: number
}

/**
 * Everything about a learner that survives a browser: what they assert
 * (profile), what they have done (progress), and how they got there
 * (conversation). Not just a display name.
 */
export interface LearnerState {
  /** Null on an account that has never saved — the client should push, not adopt. */
  profile: LearnerProfile | null
  progress: Record<string, ItemStatus>
  conversation: ChatMessage[]
  /** Per-skill posterior from graded checks. Replayed as the next prior. */
  mastery: Record<SkillId, MasteryRecord>
  /** Path changes the learner has not clicked through yet. */
  marks: Record<string, PathMark>
  /** Items ticked with no check behind them — the server was unreachable. */
  unverified: Record<string, boolean>
}

export interface AuthSession extends LearnerState {
  /** Null when the project requires email confirmation and it is pending. */
  user: AccountUser | null
  pendingConfirmation: boolean
  message?: string
  expiresAt?: number
}

export interface WhoAmI extends LearnerState {
  user: AccountUser | null
  /** False when the server has no Supabase credentials — hide sign-in. */
  available: boolean
  registrationOpen: boolean
  /** False when the server cannot delete accounts — hide the button. */
  canDeleteAccount: boolean
}

/** Answers 200 with `user: null` when nobody is signed in — not an error. */
export const getAuthMe = (signal?: AbortSignal) =>
  request<WhoAmI>('GET', '/auth/me', undefined, signal)

export const postRegister = (
  input: { email: string; password: string; name: string },
  signal?: AbortSignal,
) => request<AuthSession>('POST', '/auth/register', input, signal)

export const postLogin = (
  input: { email: string; password: string },
  signal?: AbortSignal,
) => request<AuthSession>('POST', '/auth/login', input, signal)

export const postLogout = (signal?: AbortSignal) =>
  request<{ ok: true }>('POST', '/auth/logout', undefined, signal)

export const postLogoutAll = (signal?: AbortSignal) =>
  request<{ ok: true }>('POST', '/auth/logout-all', undefined, signal)

export const patchAccount = (
  patch: { name?: string; email?: string },
  signal?: AbortSignal,
) =>
  request<{ user: AccountUser; emailPending: boolean }>('PATCH', '/auth/me', patch, signal)

export const postPasswordChange = (
  input: { currentPassword: string; newPassword: string },
  signal?: AbortSignal,
) =>
  request<{ ok: true; signedOutEverywhere: true }>('POST', '/auth/password', input, signal)

export const deleteAccount = (signal?: AbortSignal) =>
  request<{ ok: true }>('DELETE', '/auth/me', undefined, signal)

export const getSavedState = (signal?: AbortSignal) =>
  request<LearnerState>('GET', '/me/state', undefined, signal)

export const putSavedState = (state: LearnerState, signal?: AbortSignal) =>
  request<LearnerState & { savedAt: number }>('PUT', '/me/state', state, signal)

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

// ---- the three LLM edges ------------------------------------------------

/**
 * Options for the routes that may call a model. `provider` names the vendor
 * for one call ("anthropic", "openai", "google", "groq", "mistral"); the
 * server ignores it if that provider has no key, or if per-request overrides
 * are turned off, and answers from the normal chain instead.
 */
export interface EdgeOptions {
  provider?: string | null
  signal?: AbortSignal
}

/** What the server's input screening did with a message. */
export interface ScreeningReport {
  /** `deterministic` and `safe-response` both mean no model was consulted. */
  action: 'allow' | 'deterministic' | 'safe-response'
  /** Machine-readable reasons, e.g. `injection:override-instructions`. */
  flags: string[]
  /** Categories of personal data removed before the text went anywhere. */
  redacted: string[]
}

/** An output check that a model answer failed, and was discarded for. */
export interface Violation {
  id: string
  detail: string
}

export interface GoalExtraction {
  goalId: string | null
  confidence: number
  restatement: string | null
  signals: string[]
  weeklyHours: number | null
  /** `keywords` means the model was unavailable, unsure, screened, or overruled. */
  source: 'llm' | 'keywords'
  degraded: boolean
  goal: Goal | null
  provider: string | null
  model: string | null
  screening: ScreeningReport
}

export const postGoalExtract = (
  text: string,
  profile?: LearnerProfile,
  options: EdgeOptions = {},
) =>
  request<GoalExtraction>(
    'POST',
    '/goal/extract',
    { text, profile, provider: options.provider ?? undefined },
    options.signal,
  )

export interface ChatResponse {
  reply: AssistantReply
  /** Who wrote the words. `rules` means the model was unavailable or wrong. */
  answeredBy: 'model' | 'rules'
  /** The rule-based answer the model was asked to rephrase. */
  deterministicText: string
  /** Which vendor wrote the wording, when one did. */
  answeredByProvider: string | null
  answeredByModel: string | null
  /** Non-empty when a model answer was discarded by an output check. */
  violations: Violation[]
  /** Non-null only when the model was asked to resolve a goal. */
  extraction: Omit<GoalExtraction, 'goal'> | null
  /** The profile with the reply's effects already applied. */
  profile: LearnerProfile
  profileChanged: boolean
  path: LearningPath | null
  screening: ScreeningReport
}

export const postChat = (text: string, profile: LearnerProfile, options: EdgeOptions = {}) =>
  request<ChatResponse>(
    'POST',
    '/chat',
    { text, profile, provider: options.provider ?? undefined },
    options.signal,
  )

export interface NarrationResponse {
  resourceId: string
  text: string
  /** `template` means the deterministic explanation, verbatim. */
  source: 'llm' | 'template'
  degraded: boolean
  provider: string | null
  model: string | null
  /** Non-empty when the prose was discarded for failing an output check. */
  violations: Violation[]
  reasons: Reason[]
  closes: PathItem['closes']
}

export const postNarrate = (
  profile: LearnerProfile,
  resourceId: string,
  style: 'brief' | 'coaching' = 'brief',
  options: EdgeOptions = {},
) =>
  request<NarrationResponse>(
    'POST',
    '/narrate',
    { profile, resourceId, style, provider: options.provider ?? undefined },
    options.signal,
  )

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

// ---- onboarding ---------------------------------------------------------

/** One answer to one questionnaire step, in the shape the server reads. */
export interface OnboardingAnswer {
  stepId: string
  /** Free text for a text step; option ids otherwise. */
  values: string[]
}

/**
 * A follow-up the model thought worth asking. Every option carries the tag or
 * skill id it writes, validated server-side against the catalogue, so a
 * follow-up can only move the profile in ways the static steps already can.
 */
export interface FollowupQuestion {
  id: string
  prompt: string
  options: Array<{ id: string; label: string; tag?: string; skillId?: SkillId }>
}

export interface FollowupResponse {
  questions: FollowupQuestion[]
  source: 'llm' | 'none'
  degraded: boolean
  provider: string | null
  model: string | null
}

export const postOnboardingFollowup = (
  payload: { profile: LearnerProfile; answers: OnboardingAnswer[] },
  options: EdgeOptions = {},
) =>
  request<FollowupResponse>(
    'POST',
    '/onboarding/followup',
    { ...payload, provider: options.provider ?? undefined },
    options.signal,
  )

export interface IntroResponse {
  text: string
  /** `template` means the deterministic summary, verbatim. */
  source: 'llm' | 'template'
  degraded: boolean
  provider: string | null
  model: string | null
  violations: Violation[]
}

export const postOnboardingSummary = (
  payload: { profile: LearnerProfile; answers: OnboardingAnswer[] },
  options: EdgeOptions = {},
) =>
  request<IntroResponse>(
    'POST',
    '/onboarding/summary',
    { ...payload, provider: options.provider ?? undefined },
    options.signal,
  )

// ---- diagnostics --------------------------------------------------------

/** One registered provider, whether or not it has a key. */
export interface ProviderStatus {
  id: string
  label: string
  /** A key is present in the environment for this provider. */
  configured: boolean
  /** Which env var supplied it. Never the value. */
  keySource: string | null
  /** Eight hex characters of SHA-256, to confirm which key is loaded. */
  keyFingerprint: string | null
  model: string
  packageName: string
  unavailableReason: string | null
  pricingPerMTok: { input: number; output: number }
  envKeys: string[]
}

export interface BudgetReport {
  windowMs: number
  windowStartedAt: number
  limits: { calls: number | null; tokens: number | null; usd: number | null }
  used: { calls: number; inputTokens: number; outputTokens: number; usd: number }
  remaining: { calls: number | null; tokens: number | null; usd: number | null }
  byProvider: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; usd: number }
  >
}

export interface HealthResponse {
  ok: boolean
  uptimeSeconds: number
  /** The only field present when auth is on and the caller did not send a key. */
  authRequired?: boolean
  auth?: { required: boolean }
  llm?: {
    enabled: boolean
    mode: 'auto' | 'on' | 'off'
    calls: number
    fallbacks: number
    guardrailBlocks: number
    screened: number
    lastError: string | null
    lastErrorAt: number | null
    lastViolations: Violation[]
    byProvider: Record<string, { calls: number; failures: number; lastError: string | null }>
    timeoutMs: number
    /** Providers that would be tried, in order, for the next call. */
    chain: string[]
    providers: ProviderStatus[]
  }
  budget?: BudgetReport
  guardrails?: {
    injectionPolicy: 'deterministic' | 'sanitize'
    rateLimitPerWindow: number
    screened: number
    outputsRejected: number
    lastViolations: Violation[]
  }
  catalog?: { skills: number; resources: number; goals: number }
  quiz?: {
    version: number
    items: number
    skills: string[]
    unreviewed: string[]
  }
}

export const getHealth = (signal?: AbortSignal) =>
  request<HealthResponse>('GET', '/health', undefined, signal)

// ---- providers ----------------------------------------------------------

export interface ProvidersResponse {
  enabled: boolean
  mode: 'auto' | 'on' | 'off'
  /** Failover order given the keys present right now. */
  chain: string[]
  failover: boolean
  perRequestOverride: boolean
  providers: ProviderStatus[]
  budget: BudgetReport
}

/** Configuration only. Calls nobody, costs nothing. */
export const getProviders = (signal?: AbortSignal) =>
  request<ProvidersResponse>('GET', '/providers', undefined, signal)

export interface ProviderCheck {
  id: string
  model: string | null
  ok: boolean
  latencyMs: number
  error: string | null
}

export interface ProviderCheckResponse {
  checked: ProviderCheck[]
  summary: { total: number; ok: number; failed: number }
  note?: string
  budget: BudgetReport
}

/**
 * One real, minimal call per configured provider. This is the difference
 * between a key being set and a key working — omit `providers` to check
 * every one that has a key.
 */
export const postProviderCheck = (providers?: string[], signal?: AbortSignal) =>
  request<ProviderCheckResponse>('POST', '/providers/check', { providers }, signal)
