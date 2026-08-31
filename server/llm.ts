/**
 * The five places a language model is allowed to touch this product.
 *
 *   1. `extractGoal` — free text in, one of the catalogue's known goal ids
 *      out. The model chooses from a closed set, so it cannot invent a goal
 *      and therefore cannot invent a curriculum.
 *   2. `narrate` — rewrites an explanation the engine has already computed.
 *      It is handed the finished reasons and asked for prose. It is never
 *      asked what the reasons are.
 *   3. `converse` — the same principle applied to conversation. The rules
 *      have already produced a correct answer; the model says it well.
 *   4. `onboardingFollowup` — decides whether the fixed questionnaire left
 *      something ambiguous, and picks which catalogue ids to ask about. It
 *      writes the wording; it cannot invent an option.
 *   5. `onboardingIntro` — narration again, applied to the answers.
 *
 * Anything the model gets wrong is a wording problem. Selection, ordering
 * and scheduling stay in `src/lib/engine.ts`, deterministic.
 *
 * Every call is bracketed by guardrails. Inbound, `guard.screenInput` treats
 * learner text as data and fences it; a message that tries to steer the
 * model is answered by the rules instead. Outbound, `guard.validateOutput`
 * checks the prose against the engine's own facts and discards it if the
 * model reached for a number, a course, a provider or a promise the engine
 * never produced.
 *
 * All three always return a usable answer. No key, no provider, a timeout,
 * a rate limit, an exhausted budget, a malformed response, a refusal and a
 * failed guardrail all land in the same place: the deterministic result,
 * flagged `degraded`.
 */

import type { AIMessage } from '@langchain/core/messages'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { ALL_TAGS, SKILLS, getResource, skillName } from '../src/lib/catalog'
import { pathResourceIds, profileSkills, skillGaps } from '../src/lib/engine'
import { GOAL_BY_ID, GOALS, matchGoal } from '../src/lib/goals'
import { templateIntro } from '../src/lib/onboarding'
import {
  PACE_HOURS,
  type Goal,
  type LearnerProfile,
  type LearningPath,
  type Level,
  type Reason,
  type Resource,
  type SkillId,
} from '../src/lib/types.js'
import { assertWithinBudget, BudgetExceededError, recordUsage } from './budget.js'
import {
  EXTRACTION_CONFIDENCE_FLOOR,
  LLM_MAX_RETRIES,
  LLM_TIMEOUT_MS,
  MAX_NARRATION_CHARS,
  MAX_NARRATION_SENTENCES,
  MAX_REPLY_CHARS,
  MAX_REPLY_SENTENCES,
} from './config.js'
import {
  fenceRule,
  fenced,
  makeFence,
  safeField,
  screenInput,
  validateOutput,
  type InputScreening,
  type Violation,
} from './guard.js'
import {
  estimateCost,
  getModel,
  llmEnabled,
  resolveChain,
  type ProviderId,
} from './providers.js'

// ---- status -------------------------------------------------------------

interface ProviderCounters {
  calls: number
  failures: number
  lastError: string | null
}

export const llmStatus = {
  calls: 0,
  /** Times a deterministic answer was served in place of a model answer. */
  fallbacks: 0,
  /** Model answers thrown away because they failed an output check. */
  guardrailBlocks: 0,
  /** Inbound messages routed away from the model by input screening. */
  screened: 0,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
  lastViolations: [] as Violation[],
  byProvider: {} as Record<string, ProviderCounters>,
}

function counters(id: ProviderId): ProviderCounters {
  const existing = llmStatus.byProvider[id]
  if (existing) return existing
  const fresh: ProviderCounters = { calls: 0, failures: 0, lastError: null }
  llmStatus.byProvider[id] = fresh
  return fresh
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Where a model failure becomes a logged, visible degradation instead of a
 * 500. `/api/health` surfaces the last error, because a silent fallback is
 * the worst kind — the demo still "works" and nobody notices the model has
 * been out of the loop since the first request.
 */
function degrade(where: string, error: unknown): void {
  llmStatus.fallbacks += 1
  llmStatus.lastError = `${where}: ${describe(error)}`
  llmStatus.lastErrorAt = Date.now()
  console.warn(`[pathfinder] falling back to deterministic ${where} — ${describe(error)}`)
}

class RefusedError extends Error {
  constructor(category: string) {
    super(`model declined the request (${category})`)
    this.name = 'RefusedError'
  }
}

class NoProviderError extends Error {
  constructor() {
    super('no provider is configured with a key')
    this.name = 'NoProviderError'
  }
}

class GuardrailError extends Error {
  readonly violations: Violation[]

  constructor(violations: Violation[]) {
    super(`output rejected: ${violations.map((v) => `${v.id} (${v.detail})`).join('; ')}`)
    this.name = 'GuardrailError'
    this.violations = violations
  }
}

// ---- the one call path --------------------------------------------------

/**
 * Token ceiling for every edge. Generous on purpose, and not a length limit:
 * how long an answer may actually be is decided by `validateOutput`, which
 * counts sentences and characters in the finished prose and discards
 * anything over.
 *
 * The headroom is for reasoning models. A model like gpt-oss spends output
 * tokens thinking before it emits a visible word, so a budget sized for the
 * answer alone gets consumed entirely by the reasoning and returns empty
 * content — which looks exactly like a broken provider.
 */
const EDGE_MAX_TOKENS = 2400

interface CallOptions {
  tag: string
  system: string
  human: string
  maxTokens: number
  provider?: string | null
  jsonSchema?: { name: string; schema: Record<string, unknown> }
}

interface CallResult {
  text: string
  parsed: unknown
  provider: ProviderId
  model: string
}

function textOf(message: AIMessage): string {
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      typeof block === 'string' ? block : block.type === 'text' ? (block.text ?? '') : '',
    )
    .join('')
    .trim()
}

/**
 * Providers signal a policy stop in their own vocabulary. Normalising it here
 * keeps the three edges from each growing a vendor switch.
 */
function refusalOf(message: AIMessage): string | null {
  const meta = (message.response_metadata ?? {}) as Record<string, unknown>
  const kwargs = (message.additional_kwargs ?? {}) as Record<string, unknown>

  if (typeof kwargs.refusal === 'string' && kwargs.refusal.trim()) return 'refusal'

  for (const key of ['stop_reason', 'finish_reason', 'finishReason']) {
    const value = meta[key]
    if (typeof value !== 'string') continue
    const stop = value.toLowerCase()
    if (['refusal', 'content_filter', 'safety', 'prohibited_content', 'blocklist', 'recitation'].includes(stop)) {
      return stop
    }
  }
  return null
}

/**
 * Try each configured provider in turn. A vendor outage, a bad key or a
 * refusal moves to the next one; only an exhausted budget stops the walk,
 * because trying again is exactly what a budget cap exists to prevent.
 */
async function callModel(options: CallOptions): Promise<CallResult> {
  const chain = resolveChain(options.provider)
  if (chain.length === 0) throw new NoProviderError()

  let lastError: unknown = new NoProviderError()

  for (const id of chain) {
    assertWithinBudget()

    let handle: Awaited<ReturnType<typeof getModel>>
    try {
      handle = await getModel(id, { maxTokens: options.maxTokens, maxRetries: LLM_MAX_RETRIES })
    } catch (error) {
      // Never instantiated, so nothing was spent and nothing is recorded.
      lastError = error
      counters(id).failures += 1
      counters(id).lastError = describe(error)
      continue
    }

    const messages = [new SystemMessage(options.system), new HumanMessage(options.human)]
    const config = { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }

    try {
      llmStatus.calls += 1
      counters(id).calls += 1

      let raw: AIMessage
      let parsed: unknown = null

      if (options.jsonSchema) {
        // A plain JSON Schema rather than a Zod object: it is what every
        // provider's tool-calling layer speaks natively, so the same schema
        // crosses all five without a translation step.
        const structured = handle.chat.withStructuredOutput(options.jsonSchema.schema, {
          name: options.jsonSchema.name,
          includeRaw: true,
        })
        const result = (await structured.invoke(messages, config)) as {
          raw: AIMessage
          parsed: unknown
        }
        raw = result.raw
        parsed = result.parsed ?? null
      } else {
        raw = await handle.chat.invoke(messages, config)
      }

      const usage = raw.usage_metadata
      const inputTokens = usage?.input_tokens ?? 0
      const outputTokens = usage?.output_tokens ?? 0
      recordUsage({
        provider: id,
        model: handle.model,
        inputTokens,
        outputTokens,
        usd: estimateCost(id, inputTokens, outputTokens),
      })

      const refusal = refusalOf(raw)
      if (refusal) throw new RefusedError(refusal)

      return { text: textOf(raw), parsed, provider: id, model: handle.model }
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error

      // The call left the process, so it counts against the cap even though
      // we cannot see what it consumed.
      recordUsage({ provider: id, model: handle.model, inputTokens: 0, outputTokens: 0, usd: 0 })
      lastError = error
      counters(id).failures += 1
      counters(id).lastError = describe(error)
      console.warn(`[pathfinder] ${options.tag}: ${id} failed — ${describe(error)}`)
    }
  }

  throw lastError
}

// ---- edge 1: goal extraction -------------------------------------------

export interface GoalExtraction {
  /** Always an id the catalogue knows, or null. Never anything else. */
  goalId: string | null
  /** 0-1. The model's own estimate when `source` is `llm`, a heuristic otherwise. */
  confidence: number
  /** The goal in the learner's own terms, for the assistant to echo back. */
  restatement: string | null
  /** Phrases that drove the decision. */
  signals: string[]
  /** Weekly hours if the learner stated them, else null. */
  weeklyHours: number | null
  source: 'llm' | 'keywords'
  degraded: boolean
  /** Which vendor answered. Null when the keyword fallback did. */
  provider: ProviderId | null
  model: string | null
  /** What input screening did with the message. */
  screening: ScreeningReport
}

export interface ScreeningReport {
  action: InputScreening['action']
  flags: string[]
  redacted: string[]
}

function reportOf(screening: InputScreening): ScreeningReport {
  return { action: screening.action, flags: screening.flags, redacted: screening.redacted }
}

const goalIdValues = ['unknown', ...GOALS.map((goal) => goal.id)]

/** Portable across providers; validated again on the way back regardless. */
const GOAL_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    goal_id: {
      type: 'string',
      enum: goalIdValues,
      description: 'The best matching goal id, or "unknown" if none of them fit.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'How confident you are in that id. Be honest; low is fine.',
    },
    restatement: {
      type: 'string',
      description: "One sentence restating the learner's aim in their own words.",
    },
    signals: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 6,
      description: 'Short phrases from the message that drove the choice.',
    },
    weekly_hours: {
      type: 'integer',
      minimum: 0,
      maximum: 80,
      description: 'Hours per week the learner said they can study. 0 if not stated.',
    },
  },
  required: ['goal_id', 'confidence', 'restatement', 'signals', 'weekly_hours'],
  additionalProperties: false,
} as const

/**
 * The parsed object is re-validated here rather than trusted. Structured
 * output is a strong constraint on a good day and a suggestion on a bad one,
 * and five providers means five implementations of it.
 */
const GoalExtractionResult = z.object({
  goal_id: z.string(),
  confidence: z.number().min(0).max(1),
  restatement: z.string(),
  signals: z.array(z.string()).max(6),
  weekly_hours: z.number().int().min(0).max(80),
})

const EXTRACTION_RULES = [
  'You classify a free-text career statement into exactly one of the learning tracks below, or "unknown".',
  '',
  'Tracks:',
  ...GOALS.map((goal) => {
    const skills = Object.keys(goal.target).map(skillName).join(', ')
    return `- ${goal.id} — ${goal.title}. ${goal.blurb} Covers: ${skills}.`
  }),
  '',
  'Rules:',
  '- Choose only from the ids listed. If the statement fits none of them, answer "unknown" rather than forcing the closest one.',
  '- Judge the destination, not the vocabulary. "I want to put models in production" is ml-engineer even without the words.',
  '- A question about an existing plan, small talk, or a remark about scheduling is "unknown".',
  `- Confidence is your own estimate. Below ${EXTRACTION_CONFIDENCE_FLOOR} the system ignores your answer and falls back to keyword matching, so there is nothing to gain by inflating it.`,
  '- The restatement must not promise outcomes, salaries or timelines.',
]

function keywordExtraction(
  text: string,
  degraded: boolean,
  screening: InputScreening,
): GoalExtraction {
  const match = matchGoal(text)
  return {
    goalId: match?.goal.id ?? null,
    // matchGoal returns an unbounded keyword score, not a probability. This
    // maps it onto 0-1 so every caller sees one shape; `source: 'keywords'`
    // is what tells you it is a heuristic.
    confidence: match ? Math.min(0.9, 0.45 + match.score * 0.05) : 0,
    restatement: null,
    signals: match
      ? match.goal.keywords.filter((keyword) => text.toLowerCase().includes(keyword))
      : [],
    weeklyHours: null,
    source: 'keywords',
    degraded,
    provider: null,
    model: null,
    screening: reportOf(screening),
  }
}

export interface EdgeOptions {
  /** Name a provider for this call. Ignored unless overrides are allowed. */
  provider?: string | null
  /** Reuse a screening the caller already performed on the same text. */
  screening?: InputScreening
}

export async function extractGoal(
  text: string,
  profile?: LearnerProfile,
  options: EdgeOptions = {},
): Promise<GoalExtraction> {
  const screening = options.screening ?? screenInput(text)

  // A message trying to steer the model is classified by keywords instead.
  // The rules cannot be talked out of their answer.
  if (screening.action !== 'allow') {
    if (!options.screening) llmStatus.screened += 1
    return keywordExtraction(screening.text, false, screening)
  }

  if (!llmEnabled()) return keywordExtraction(screening.text, false, screening)

  const fence = makeFence()

  try {
    const context = profile
      ? `Context (background, not the thing to classify): experience "${profile.experience}", ${profile.completed.length} completed resources, interests: ${profile.interests.map((i) => safeField(i, 60)).join(', ') || 'none stated'}.`
      : ''

    const result = await callModel({
      tag: 'goal extraction',
      provider: options.provider,
      maxTokens: EDGE_MAX_TOKENS,
      system: [...EXTRACTION_RULES, '', fenceRule(fence)].join('\n'),
      human: [context, 'Learner statement:', fenced(fence, screening.text)]
        .filter(Boolean)
        .join('\n\n'),
      jsonSchema: { name: 'goal_extraction', schema: GOAL_EXTRACTION_SCHEMA },
    })

    const validated = GoalExtractionResult.safeParse(result.parsed)
    if (!validated.success) throw new Error('structured output was empty or failed to parse')
    const parsed = validated.data

    // The model chose from a closed set, but trust nothing that reaches the
    // engine: re-check the id against the catalogue.
    const goal = GOAL_BY_ID[parsed.goal_id]
    if (!goal) return keywordExtraction(screening.text, false, screening)

    if (parsed.confidence < EXTRACTION_CONFIDENCE_FLOOR) {
      // Not a failure — the model said it was unsure, so keywords decide.
      const fallback = keywordExtraction(screening.text, false, screening)
      return fallback.goalId ? fallback : { ...fallback, confidence: parsed.confidence }
    }

    // The restatement is prose shown to the learner, so it faces the same
    // checks as any other prose. Its facts are the learner's own words.
    const restatement = parsed.restatement.trim()
    if (restatement) {
      const violations = validateOutput(
        restatement,
        `${screening.text}\n${goal.title}\n${goal.blurb}`,
        { maxSentences: 2, maxChars: 300, fence },
      )
      if (violations.length > 0) throw new GuardrailError(violations)
    }

    return {
      goalId: goal.id,
      confidence: parsed.confidence,
      restatement: restatement || null,
      signals: parsed.signals,
      weeklyHours: parsed.weekly_hours > 0 ? parsed.weekly_hours : null,
      source: 'llm',
      degraded: false,
      provider: result.provider,
      model: result.model,
      screening: reportOf(screening),
    }
  } catch (error) {
    if (error instanceof GuardrailError) {
      llmStatus.guardrailBlocks += 1
      llmStatus.lastViolations = error.violations
    }
    degrade('goal extraction', error)
    return keywordExtraction(screening.text, true, screening)
  }
}

// ---- edge 2: narration --------------------------------------------------

export interface NarrationInput {
  resource: Resource
  goal: Goal
  profile: LearnerProfile
  reasons: Reason[]
  closes: Array<{ skillId: SkillId; from: Level; to: Level }>
  position: { index: number; total: number }
  style: 'brief' | 'coaching'
  provider?: string | null
}

export interface Narration {
  text: string
  source: 'llm' | 'template'
  degraded: boolean
  provider: ProviderId | null
  model: string | null
  /** Output checks that failed, when the prose was discarded. */
  violations: Violation[]
}

const NARRATION_RULES = [
  'You rewrite a recommendation that a deterministic engine has already decided.',
  '',
  'You are given the finished reasons. Your only job is to turn them into two or three sentences a learner would actually read.',
  '',
  'Hard rules:',
  '- Never introduce a fact, number, level, course, provider, duration or claim that is not in the facts you were given.',
  '- Never promise a job, a salary, a grade or a timeline.',
  '- No greeting, no sign-off, no heading, no bullet points. Prose only.',
  '- Do not hedge with "might" or "could" about things the facts state plainly.',
  '- If the facts are thin, write less. Padding is worse than brevity.',
].join('\n')

/** The deterministic explanation the UI already renders. Always available. */
function templateNarration(input: NarrationInput): string {
  return input.reasons.map((reason) => reason.text).join(' ')
}

function factSheet(input: NarrationInput): string {
  const { resource, goal, profile, reasons, closes, position } = input
  return [
    `Learner name: ${safeField(profile.name)}`,
    `Goal: ${goal.title} — ${goal.blurb}`,
    `Step ${position.index + 1} of ${position.total} in the path.`,
    `Resource: "${resource.title}" (${resource.kind}, ${resource.provider}, ${resource.hours} hours, difficulty band ${resource.level}).`,
    `Summary: ${resource.summary}`,
    closes.length > 0
      ? `Skill movement: ${closes
          .map(
            (close) =>
              `${skillName(close.skillId)} ${close.from} to ${close.to} (goal needs ${goal.target[close.skillId] ?? 'nothing specific'})`,
          )
          .join('; ')}.`
      : 'Skill movement: none — this item validates or applies skills already covered.',
    'Reasons computed by the engine:',
    ...reasons.map((reason) => `- [${reason.kind}] ${reason.text}`),
  ].join('\n')
}

export async function narrate(input: NarrationInput): Promise<Narration> {
  const template = templateNarration(input)
  const offline: Narration = {
    text: template,
    source: 'template',
    degraded: false,
    provider: null,
    model: null,
    violations: [],
  }

  if (!llmEnabled()) return offline

  const facts = factSheet(input)

  try {
    const result = await callModel({
      tag: 'narration',
      provider: input.provider,
      maxTokens: EDGE_MAX_TOKENS,
      system: NARRATION_RULES,
      human: [
        facts,
        '',
        input.style === 'coaching'
          ? 'Write it as a coach speaking directly to the learner ("you"). Two or three sentences.'
          : 'Write it as a neutral explanation. Two sentences.',
      ].join('\n'),
    })

    if (!result.text) throw new Error('model returned no text')

    const violations = validateOutput(result.text, facts, {
      maxSentences: MAX_NARRATION_SENTENCES,
      maxChars: MAX_NARRATION_CHARS,
      prose: true,
    })
    if (violations.length > 0) throw new GuardrailError(violations)

    return {
      text: result.text,
      source: 'llm',
      degraded: false,
      provider: result.provider,
      model: result.model,
      violations: [],
    }
  } catch (error) {
    const violations = error instanceof GuardrailError ? error.violations : []
    if (violations.length > 0) {
      llmStatus.guardrailBlocks += 1
      llmStatus.lastViolations = violations
    }
    degrade('narration', error)
    return { ...offline, degraded: true, violations }
  }
}

// ---- edge 3: answering in the assistant --------------------------------
//
// The engine has already decided the plan and the rule-based assistant has
// already produced a correct answer; the model turns that, plus the live
// facts behind it, into something a person would want to read. It is given
// no freedom to decide anything — only to say it well.

export interface ConversationInput {
  question: string
  profile: LearnerProfile
  goal: Goal | undefined
  path: LearningPath | null
  /** What the rules answered. The floor, and the fallback. */
  deterministic: string
  intent: string
  provider?: string | null
  /** Screening already performed by the route, so it runs once per message. */
  screening?: InputScreening
}

export interface Conversation {
  text: string
  source: 'llm' | 'rules'
  degraded: boolean
  provider: ProviderId | null
  model: string | null
  violations: Violation[]
}

const CONVERSATION_RULES = [
  "You are Pathfinder's assistant. A learner is asking about their own learning plan.",
  '',
  'The FACTS block is computed by a deterministic engine and is your only source of truth. It already contains the correct answer; your job is to say it well.',
  '',
  'Hard rules:',
  '- At most three sentences. Warm, direct, specific. No preamble, no filler, no sign-off.',
  '- Never state a course, provider, number, level, duration or claim that is not in the FACTS.',
  '- If the FACTS do not answer the question, say so in one sentence and offer the nearest thing you can answer.',
  '- Never promise a job, a salary, or an outcome.',
  '- No greetings, headings or bullet points. You may use **bold** for a course or goal name, nothing else.',
  '- Address the learner as "you".',
]

/** Everything the engine knows, laid out for the model to draw on. */
function conversationFacts(input: ConversationInput): string {
  const { profile, goal, path } = input
  const lines: string[] = [
    `Learner: ${safeField(profile.name)}, self-declared experience "${profile.experience}".`,
    `Pace: ${PACE_HOURS[profile.pace]} hours per week (${profile.pace}).`,
  ]

  if (profile.completed.length > 0) {
    lines.push(
      `Already completed: ${profile.completed
        .map((id) => getResource(id)?.title ?? id)
        .join(', ')}.`,
    )
  } else {
    lines.push('Nothing completed yet.')
  }

  if (!goal) {
    lines.push(
      `No goal set. The only tracks that can be planned are: ${GOALS.map((g) => `${g.title} (${g.blurb})`).join('; ')}.`,
    )
  } else {
    lines.push(`Goal: ${goal.title} — ${goal.blurb}`)

    const levels = profileSkills(profile)
    const gaps = skillGaps(profile, goal, levels)
    lines.push(
      `Skill standing (current -> target): ${gaps
        .map((g) => `${skillName(g.skillId)} ${g.current}->${g.target}${g.gap === 0 ? ' (met)' : ''}`)
        .join(', ')}.`,
    )
  }

  if (path) {
    const order = pathResourceIds(path)
    lines.push(
      `Path: ${order.length} items, ${path.totalHours} hours total, about ${path.weeks} weeks at the current pace, in ${path.milestones.length} milestones.`,
    )
    lines.push('Items in order:')
    path.milestones.forEach((milestone) => {
      lines.push(`  Milestone "${milestone.title}" — ${milestone.outcome}`)
      milestone.items.forEach((item) => {
        const resource = getResource(item.resourceId)
        if (!resource) return
        const done = profile.completed.includes(resource.id) ? ' [done]' : ''
        lines.push(
          `    ${order.indexOf(resource.id) + 1}. ${resource.title} (${resource.kind}, ${resource.provider}, ${resource.hours} hrs, band ${resource.level})${done} — ${item.reasons.map((r) => r.text).join(' ')}`,
        )
      })
    })

    const nextId = order.find((id) => !profile.completed.includes(id))
    const next = nextId ? getResource(nextId) : undefined
    if (next) lines.push(`Next up: ${next.title}.`)

    if (path.uncovered.length > 0) {
      lines.push(
        `The catalogue cannot fully cover: ${path.uncovered
          .map((u) => `${skillName(u.skillId)} (reaches ${u.from} of ${u.target})`)
          .join(', ')}.`,
      )
    }
  } else {
    lines.push('No path has been generated yet.')
  }

  lines.push(
    '',
    `The rule-based assistant already answered this correctly, if drily. Its answer: "${input.deterministic}"`,
  )

  return lines.join('\n')
}

export async function converse(input: ConversationInput): Promise<Conversation> {
  const rules: Conversation = {
    text: input.deterministic,
    source: 'rules',
    degraded: false,
    provider: null,
    model: null,
    violations: [],
  }

  const screening = input.screening ?? screenInput(input.question)
  if (screening.action !== 'allow') {
    if (!input.screening) llmStatus.screened += 1
    return rules
  }

  if (!llmEnabled()) return rules

  const facts = conversationFacts(input)
  const fence = makeFence()

  try {
    const result = await callModel({
      tag: 'assistant reply',
      provider: input.provider,
      maxTokens: EDGE_MAX_TOKENS,
      system: [...CONVERSATION_RULES, '', fenceRule(fence)].join('\n'),
      human: `FACTS\n${facts}\n\nThe learner asked:\n${fenced(fence, screening.text)}`,
    })

    if (!result.text) throw new Error('model returned no text')

    const violations = validateOutput(result.text, facts, {
      maxSentences: MAX_REPLY_SENTENCES,
      maxChars: MAX_REPLY_CHARS,
      prose: true,
      fence,
    })
    if (violations.length > 0) throw new GuardrailError(violations)

    return {
      text: result.text,
      source: 'llm',
      degraded: false,
      provider: result.provider,
      model: result.model,
      violations: [],
    }
  } catch (error) {
    const violations = error instanceof GuardrailError ? error.violations : []
    if (violations.length > 0) {
      llmStatus.guardrailBlocks += 1
      llmStatus.lastViolations = violations
    }
    degrade('assistant reply', error)
    return { ...rules, degraded: true, violations }
  }
}

// ---- edge 4: onboarding follow-ups -------------------------------------
//
// The questionnaire itself is committed data — the same steps for everyone,
// model or no model. This edge only decides whether the fixed steps left
// something genuinely ambiguous, and if so asks at most two more questions.
//
// The model writes the wording and nothing else. Every option it can offer is
// an id already in the catalogue, checked against it on the way back, so a
// follow-up can only move the profile in ways the static steps could too.

/** What one follow-up option writes when the learner picks it. */
export interface FollowupOption {
  id: string
  label: string
  /** An interest tag, when that is what the question is about. */
  tag?: string
  /** A skill the learner is asserting hands-on familiarity with. */
  skillId?: SkillId
}

export interface FollowupQuestion {
  id: string
  prompt: string
  options: FollowupOption[]
}

export interface Followups {
  questions: FollowupQuestion[]
  source: 'llm' | 'none'
  degraded: boolean
  provider: ProviderId | null
  model: string | null
}

/** One answered questionnaire step, as the client records it. */
export interface OnboardingAnswer {
  stepId: string
  values: string[]
}

const followupValues = [...ALL_TAGS, ...SKILLS.map((skill) => skill.id)]

const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The question, one sentence, addressed to the learner as "you".',
          },
          kind: {
            type: 'string',
            enum: ['interest', 'skill'],
            description:
              'interest — the options are things they might want to work on. skill — the options are things they may already have hands-on experience with.',
          },
          values: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: { type: 'string', enum: followupValues },
            description: 'The options to offer, as ids from the list. Nothing else is allowed.',
          },
        },
        required: ['prompt', 'kind', 'values'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const

const FollowupResult = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string(),
        kind: z.enum(['interest', 'skill']),
        values: z.array(z.string()).min(1).max(6),
      }),
    )
    .max(2),
})

const FOLLOWUP_RULES = [
  'A learner has just answered a fixed onboarding questionnaire. You decide whether anything important is still missing, and if so ask at most two short follow-up questions.',
  '',
  'Ask only when one of these is true, and return an empty list when none of them is:',
  '- Their stated interests do not overlap the skills their goal needs, so the planner has nothing to break ties with. This is the usual reason to ask.',
  '- No goal was resolved from their statement, so nothing is known about where they are heading.',
  '- They rated themselves at a level that contradicts what they said about their experience.',
  '',
  'Hard rules:',
  '- One question is almost always enough. Asking a second for the sake of it wastes the only attention you get.',
  '- Every option must be an id from the allowed list. You are choosing which to put in front of them, not inventing new ones.',
  '- One sentence per question. No preamble, no explanation, no greeting.',
  '- Never ask about salary, employer, age, location, health, or anything else that is none of the plan’s business.',
  '- Do not re-ask something the answers below already say.',
]

function answerSheet(profile: LearnerProfile, answers: OnboardingAnswer[]): string {
  const goal = GOAL_BY_ID[profile.goalId ?? '']
  const gaps = goal
    ? Object.keys(goal.target)
        .map(skillName)
        .join(', ')
    : 'no goal resolved'

  return [
    `Learner name: ${safeField(profile.name)}`,
    `Goal: ${goal ? `${goal.title} — ${goal.blurb}` : 'not resolved from their statement'}`,
    `Skills that goal needs: ${gaps}`,
    `Stated experience: ${profile.experience}`,
    `Weekly pace: ${profile.pace}`,
    `Interests they picked: ${profile.interests.map((i) => safeField(i, 60)).join(', ') || 'none'}`,
    `Things they would rather avoid: ${profile.avoid.map((i) => safeField(i, 60)).join(', ') || 'none'}`,
    `Self-rated skills: ${
      Object.entries(profile.selfRated)
        .map(([skillId, level]) => `${skillName(skillId)} ${level}`)
        .join(', ') || 'none'
    }`,
    'Raw answers:',
    ...answers.map(
      (answer) => `- ${safeField(answer.stepId, 60)}: ${answer.values.map((v) => safeField(v, 120)).join(', ')}`,
    ),
  ].join('\n')
}

const NO_FOLLOWUPS: Followups = {
  questions: [],
  source: 'none',
  degraded: false,
  provider: null,
  model: null,
}

export async function onboardingFollowup(
  profile: LearnerProfile,
  answers: OnboardingAnswer[],
  options: EdgeOptions = {},
): Promise<Followups> {
  // The deterministic answer to "is anything missing?" is "no". That is not a
  // degraded questionnaire — it is the questionnaire, which is fixed and
  // complete on its own.
  if (!llmEnabled()) return NO_FOLLOWUPS

  const facts = answerSheet(profile, answers)
  const fence = makeFence()

  try {
    const result = await callModel({
      tag: 'onboarding follow-up',
      provider: options.provider,
      maxTokens: EDGE_MAX_TOKENS,
      system: [
        ...FOLLOWUP_RULES,
        '',
        `Allowed option ids: ${followupValues.join(', ')}.`,
        '',
        fenceRule(fence),
      ].join('\n'),
      human: ['What they answered:', fenced(fence, facts)].join('\n\n'),
      jsonSchema: { name: 'onboarding_followup', schema: FOLLOWUP_SCHEMA },
    })

    const validated = FollowupResult.safeParse(result.parsed)
    if (!validated.success) throw new Error('structured output was empty or failed to parse')

    const tags = new Set(ALL_TAGS)
    const skills = new Set(SKILLS.map((skill) => skill.id))
    const questions: FollowupQuestion[] = []

    for (const [index, question] of validated.data.questions.entries()) {
      const prompt = question.prompt.trim()
      if (!prompt) continue

      // Prose shown to the learner, so it faces the same output check as any
      // other prose this server produces.
      const violations = validateOutput(prompt, facts, {
        maxSentences: 1,
        maxChars: 200,
        fence,
      })
      if (violations.length > 0) throw new GuardrailError(violations)

      // The enum in the schema is a constraint on a good day and a suggestion
      // on a bad one. The catalogue decides.
      const seen = new Set<string>()
      const opts: FollowupOption[] = []
      for (const value of question.values) {
        if (seen.has(value)) continue
        seen.add(value)
        if (question.kind === 'interest' && tags.has(value)) {
          opts.push({ id: value, label: value, tag: value })
        } else if (question.kind === 'skill' && skills.has(value)) {
          opts.push({ id: value, label: skillName(value), skillId: value })
        }
      }

      if (opts.length < 2) continue
      questions.push({ id: `followup-${index + 1}`, prompt, options: opts })
    }

    return {
      questions,
      source: 'llm',
      degraded: false,
      provider: result.provider,
      model: result.model,
    }
  } catch (error) {
    if (error instanceof GuardrailError) {
      llmStatus.guardrailBlocks += 1
      llmStatus.lastViolations = error.violations
    }
    degrade('onboarding follow-up', error)
    return { ...NO_FOLLOWUPS, degraded: true }
  }
}

// ---- edge 5: the closing summary ---------------------------------------
//
// Same shape as narration: the facts are already decided, and the model is
// asked only to say them back in a way the learner recognises themselves in.

export interface Intro {
  text: string
  source: 'llm' | 'template'
  degraded: boolean
  provider: ProviderId | null
  model: string | null
  violations: Violation[]
}

const INTRO_RULES = [
  'You summarise what a learner just told an onboarding questionnaire, back to them, in two or three sentences.',
  '',
  'Hard rules:',
  '- Use only the facts given. Never add a skill, course, provider, duration, number or claim that is not there.',
  '- Never promise a job, a salary, a grade or a timeline.',
  '- Address them as "you". No greeting, no sign-off, no bullet points, no heading.',
  '- If they said they want to avoid something, acknowledge it plainly rather than talking them out of it.',
  '- Thin answers get a short summary. Padding is worse than brevity.',
].join('\n')

export async function onboardingIntro(
  profile: LearnerProfile,
  answers: OnboardingAnswer[],
  options: EdgeOptions = {},
): Promise<Intro> {
  const template = templateIntro(profile)
  const offline: Intro = {
    text: template,
    source: 'template',
    degraded: false,
    provider: null,
    model: null,
    violations: [],
  }

  if (!llmEnabled()) return offline

  const facts = answerSheet(profile, answers)
  const fence = makeFence()

  try {
    const result = await callModel({
      tag: 'onboarding summary',
      provider: options.provider,
      maxTokens: EDGE_MAX_TOKENS,
      system: [INTRO_RULES, '', fenceRule(fence)].join('\n'),
      human: [fenced(fence, facts), '', 'Write the summary.'].join('\n'),
    })

    if (!result.text) throw new Error('model returned no text')

    const violations = validateOutput(result.text, facts, {
      maxSentences: MAX_NARRATION_SENTENCES,
      maxChars: MAX_NARRATION_CHARS,
      prose: true,
      fence,
    })
    if (violations.length > 0) throw new GuardrailError(violations)

    return {
      text: result.text,
      source: 'llm',
      degraded: false,
      provider: result.provider,
      model: result.model,
      violations: [],
    }
  } catch (error) {
    const violations = error instanceof GuardrailError ? error.violations : []
    if (violations.length > 0) {
      llmStatus.guardrailBlocks += 1
      llmStatus.lastViolations = violations
    }
    degrade('onboarding summary', error)
    return { ...offline, degraded: true, violations }
  }
}
