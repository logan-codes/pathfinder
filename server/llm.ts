/**
 * The two places a language model is allowed to touch this product.
 *
 *   1. `extractGoal` — free text in, one of the catalogue's known goal ids
 *      out. The model chooses from a closed set, so it cannot invent a goal
 *      and therefore cannot invent a curriculum.
 *   2. `narrate` — rewrites an explanation the engine has already computed.
 *      It is handed the finished reasons and asked for prose. It is never
 *      asked what the reasons are.
 *
 * Anything the model gets wrong is a wording problem. Selection, ordering
 * and scheduling stay in `src/lib/engine.ts`, deterministic.
 *
 * Both functions always return a usable answer. Missing credentials, a
 * timeout, a rate limit, a malformed response and a refusal all land in the
 * same place: the deterministic result, flagged `degraded`.
 */

import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { getResource, skillName } from '../src/lib/catalog'
import { pathResourceIds, profileSkills, skillGaps } from '../src/lib/engine'
import { GOAL_BY_ID, GOALS, matchGoal } from '../src/lib/goals'
import {
  PACE_HOURS,
  type Goal,
  type LearnerProfile,
  type LearningPath,
  type Level,
  type Reason,
  type Resource,
  type SkillId,
} from '../src/lib/types'
import {
  EXTRACTION_CONFIDENCE_FLOOR,
  LLM_ENABLED,
  LLM_MAX_RETRIES,
  LLM_TIMEOUT_MS,
  MODEL,
  USE_REFUSAL_FALLBACKS,
} from './config'

// ---- client -------------------------------------------------------------

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    // No apiKey argument: the SDK resolves ANTHROPIC_API_KEY,
    // ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile by itself.
    client = new Anthropic({ timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES })
  }
  return client
}

export const llmStatus = {
  enabled: LLM_ENABLED,
  model: MODEL,
  calls: 0,
  fallbacks: 0,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
}

function describe(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    return `${error.name} (${error.status ?? 'no status'}): ${error.message}`
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Where a model failure becomes a logged, visible degradation instead of a
 * 500. `/api/health` surfaces the last error, because a silent fallback is
 * the worst kind — the demo still "works" and nobody notices the model is
 * out of the loop.
 */
function degrade(where: string, error: unknown): void {
  llmStatus.fallbacks += 1
  llmStatus.lastError = `${where}: ${describe(error)}`
  llmStatus.lastErrorAt = Date.now()
  console.warn(`[pathfinder] falling back to deterministic ${where} — ${describe(error)}`)
}

/**
 * A refusal is handled by falling back deterministically rather than by
 * routing to a second model, which is the stronger option here: the
 * templated path is always available and costs nothing.
 */
class RefusedError extends Error {
  constructor(category: string | null) {
    super(`model declined the request${category ? ` (${category})` : ''}`)
    this.name = 'RefusedError'
  }
}

const REFUSAL_FALLBACK_BETAS = ['server-side-fallback-2026-07-01']

const betas = USE_REFUSAL_FALLBACKS ? REFUSAL_FALLBACK_BETAS : undefined
const fallbacks = USE_REFUSAL_FALLBACKS ? ('default' as const) : undefined

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
}

const goalIdValues: [string, ...string[]] = ['unknown', ...GOALS.map((goal) => goal.id)]

const GoalExtractionSchema = z.object({
  goal_id: z
    .enum(goalIdValues)
    .describe('The best matching goal id, or "unknown" if none of them fit.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('How confident you are in that id. Be honest; low is fine.'),
  restatement: z
    .string()
    .describe("One sentence restating the learner's aim in their own words."),
  signals: z
    .array(z.string())
    .max(6)
    .describe('Short phrases from the message that drove the choice.'),
  weekly_hours: z
    .number()
    .int()
    .min(0)
    .max(80)
    .describe('Hours per week the learner said they can study. 0 if not stated.'),
})

/** Built once from the goal templates, so the prompt prefix is stable. */
const EXTRACTION_SYSTEM = [
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
  '- Confidence is your own estimate. Below 0.55 the system ignores your answer and falls back to keyword matching, so there is nothing to gain by inflating it.',
  '- The restatement must not promise outcomes, salaries or timelines.',
].join('\n')

function keywordExtraction(text: string, degraded: boolean): GoalExtraction {
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
  }
}

export async function extractGoal(
  text: string,
  profile?: LearnerProfile,
): Promise<GoalExtraction> {
  if (!LLM_ENABLED) return keywordExtraction(text, false)

  try {
    llmStatus.calls += 1

    const context = profile
      ? `Context (background, not the thing to classify): experience "${profile.experience}", ${profile.completed.length} completed resources, interests: ${profile.interests.join(', ') || 'none stated'}.`
      : ''

    const response = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system: EXTRACTION_SYSTEM,
      output_config: {
        effort: 'low',
        format: betaZodOutputFormat(GoalExtractionSchema),
      },
      messages: [
        {
          role: 'user',
          content: [context, `Learner says: "${text}"`].filter(Boolean).join('\n\n'),
        },
      ],
      betas,
      fallbacks,
    })

    if (response.stop_reason === 'refusal') {
      throw new RefusedError(response.stop_details?.category ?? null)
    }

    const parsed = response.parsed_output
    if (!parsed) throw new Error('structured output was empty or failed to parse')

    // The model chose from a closed set, but trust nothing that reaches the
    // engine: re-check the id against the catalogue.
    const goal = GOAL_BY_ID[parsed.goal_id]
    if (!goal) return keywordExtraction(text, false)

    if (parsed.confidence < EXTRACTION_CONFIDENCE_FLOOR) {
      // Not a failure — the model said it was unsure, so keywords decide.
      const fallback = keywordExtraction(text, false)
      return fallback.goalId ? fallback : { ...fallback, confidence: parsed.confidence }
    }

    return {
      goalId: goal.id,
      confidence: parsed.confidence,
      restatement: parsed.restatement.trim() || null,
      signals: parsed.signals,
      weeklyHours: parsed.weekly_hours > 0 ? parsed.weekly_hours : null,
      source: 'llm',
      degraded: false,
    }
  } catch (error) {
    degrade('goal extraction', error)
    return keywordExtraction(text, true)
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
}

export interface Narration {
  text: string
  source: 'llm' | 'template'
  degraded: boolean
}

const NARRATION_SYSTEM = [
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
    `Learner name: ${profile.name}`,
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

const digitsIn = (text: string): Set<string> => new Set(text.match(/\d+/g) ?? [])

/**
 * A cheap guard against the one failure that would actually matter: a number
 * the engine never produced. Every integer in the narration has to appear in
 * the facts, or the narration is discarded and the template served instead.
 */
function inventsNumbers(narration: string, facts: string): boolean {
  const allowed = digitsIn(facts)
  for (const found of digitsIn(narration)) {
    if (!allowed.has(found)) return true
  }
  return false
}

// ---- edge 3: answering in the assistant --------------------------------
//
// The same principle as narration, applied to conversation. The engine has
// already decided the plan and the rule-based assistant has already produced
// a correct answer; the model turns that, plus the live facts behind it,
// into something a person would actually want to read. It is given no
// freedom to decide anything — only to say it well.

export interface ConversationInput {
  question: string
  profile: LearnerProfile
  goal: Goal | undefined
  path: LearningPath | null
  /** What the rules answered. The floor, and the fallback. */
  deterministic: string
  intent: string
}

export interface Conversation {
  text: string
  source: 'llm' | 'rules'
  degraded: boolean
}

const CONVERSATION_SYSTEM = [
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
].join('\n')

/** Everything the engine knows, laid out for the model to draw on. */
function conversationFacts(input: ConversationInput): string {
  const { profile, goal, path } = input
  const lines: string[] = [
    `Learner: ${profile.name}, self-declared experience "${profile.experience}".`,
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
  if (!LLM_ENABLED) return { text: input.deterministic, source: 'rules', degraded: false }

  const facts = conversationFacts(input)

  try {
    llmStatus.calls += 1

    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: CONVERSATION_SYSTEM,
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: `FACTS\n${facts}\n\nThe learner asked: "${input.question}"`,
        },
      ],
      betas,
      fallbacks,
    })

    if (response.stop_reason === 'refusal') {
      throw new RefusedError(response.stop_details?.category ?? null)
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    if (!text) throw new Error('model returned no text')
    if (inventsNumbers(text, facts)) {
      throw new Error('answer contained a number the engine never produced')
    }

    return { text, source: 'llm', degraded: false }
  } catch (error) {
    degrade('assistant reply', error)
    return { text: input.deterministic, source: 'rules', degraded: true }
  }
}

export async function narrate(input: NarrationInput): Promise<Narration> {
  const template = templateNarration(input)
  if (!LLM_ENABLED) return { text: template, source: 'template', degraded: false }

  const facts = factSheet(input)

  try {
    llmStatus.calls += 1

    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: NARRATION_SYSTEM,
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            facts,
            '',
            input.style === 'coaching'
              ? 'Write it as a coach speaking directly to the learner ("you"). Two or three sentences.'
              : 'Write it as a neutral explanation. Two sentences.',
          ].join('\n'),
        },
      ],
      betas,
      fallbacks,
    })

    if (response.stop_reason === 'refusal') {
      throw new RefusedError(response.stop_details?.category ?? null)
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    if (!text) throw new Error('model returned no text')
    if (inventsNumbers(text, facts)) {
      throw new Error('narration contained a number the engine never produced')
    }

    return { text, source: 'llm', degraded: false }
  } catch (error) {
    degrade('narration', error)
    return { text: template, source: 'template', degraded: true }
  }
}
