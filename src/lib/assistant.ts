/**
 * The assistant's reasoning layer.
 *
 * Intents are matched with rules and every answer is composed from live
 * engine output — the assistant never states a number the dashboard would
 * contradict.
 *
 * The rules are narrow on purpose: each one is a question the engine can
 * answer from data it already has. What matters is that anything they miss
 * lands somewhere useful rather than on the same dead end — see the bottom
 * of `respond()`. When the server is running, an unmatched message is also
 * handed to a model, which may recognise a goal the keywords did not.
 */

import { SKILLS, getResource, skillName } from './catalog'
import { findPathItem, pathResourceIds, profileSkills, skillGaps } from './engine'
import { GOALS, getGoal, matchGoal } from './goals'
import { hours as fmtHours, weeks as fmtWeeks } from './format'
import {
  LEVEL_LABELS,
  PACE_HOURS,
  type ChatMessage,
  type LearnerProfile,
  type LearningPath,
  type Pace,
  type Resource,
  type Skill,
} from './types'

/** Which branch produced the reply. Lets a caller act on `unmatched`. */
export type AssistantIntent =
  | 'pace'
  | 'why-item'
  | 'why-order'
  | 'why-gaps'
  | 'why-nothing-planned'
  | 'duration'
  | 'gaps'
  | 'path'
  | 'goal'
  | 'greeting'
  | 'skip'
  | 'detail'
  | 'next'
  | 'difficulty'
  | 'known'
  | 'assess'
  | 'ack'
  | 'unmatched'

export interface AssistantReply {
  text: string
  attachment?: ChatMessage['attachment']
  suggestions?: string[]
  intent?: AssistantIntent
  /** Side effects for the caller to apply to the store. */
  effects?: {
    setGoal?: { goalId: string; statement: string }
    setPace?: Pace
  }
}

export interface Context {
  profile: LearnerProfile
  path: LearningPath | null
  /**
   * A goal already resolved by something better than keyword matching —
   * the server's model-backed extractor. When present it wins over
   * `matchGoal`, which becomes the offline fallback rather than the only
   * option. Everything after this point is unchanged: the path is still
   * built by the deterministic engine from this id.
   */
  resolvedGoalId?: string | null
}

/** "8 hours a week", "about 5 hrs/wk", "2 hours per week" */
function parseWeeklyHours(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:\+)?\s*(?:hours?|hrs?|h)\b/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0 || n > 80) return null
  // Only treat it as a weekly commitment if the sentence says so.
  if (!/week|wk|weekly/i.test(text)) return null
  return n
}

function paceForHours(n: number): Pace {
  if (n <= 5) return 'light'
  if (n <= 11) return 'steady'
  return 'intense'
}

function pathSummaryText(path: LearningPath, profile: LearnerProfile): string {
  const goal = getGoal(path.goalId)
  const count = path.milestones.reduce((n, m) => n + m.items.length, 0)
  const weekly = PACE_HOURS[profile.pace]
  return [
    `Here is a ${count}-step path to **${goal?.title ?? 'your goal'}**.`,
    `It totals ${fmtHours(path.totalHours)} — about ${fmtWeeks(path.weeks)} at ${weekly} hrs/week.`,
    `I grouped it into ${path.milestones.length} milestones so each one ends somewhere you could stop and still have gained something usable.`,
  ].join(' ')
}

/**
 * Find the path item a message is talking about.
 *
 * An exact title wins; otherwise the resource sharing the most distinctive
 * words with the message does. Scoped to the current path, which keeps it
 * from matching a course the learner was never offered.
 */
function namedResource(lower: string, path: LearningPath | null): Resource | undefined {
  if (!path) return undefined

  const inPath = path.milestones
    .flatMap((m) => m.items)
    .map((i) => getResource(i.resourceId))
    .filter((r): r is Resource => Boolean(r))

  let best: Resource | undefined
  let bestScore = 0

  for (const resource of inPath) {
    const title = resource.title.toLowerCase()
    if (lower.includes(title)) return resource

    const words = title
      .replace(/^project:\s*/, '')
      .split(/[^a-z0-9+#]+/)
      .filter((word) => word.length > 3)
    const hits = words.filter((word) => lower.includes(word)).length

    if (hits > bestScore) {
      bestScore = hits
      best = resource
    }
  }

  return bestScore > 0 ? best : undefined
}

/** Find a skill the learner named, so "I already know X" can be specific. */
function namedSkill(lower: string): Skill | undefined {
  let best: Skill | undefined
  let bestLength = 0
  for (const skill of SKILLS) {
    const name = skill.name.toLowerCase()
    if (lower.includes(name) && name.length > bestLength) {
      best = skill
      bestLength = name.length
    }
  }
  return best
}

const GOAL_PROMPT_SUGGESTIONS = GOALS.map((g) => g.title)

/** What the rules can actually answer. Used by the catch-all, so the list
 *  cannot drift from a promise the assistant fails to keep. */
const CAPABILITIES = [
  'name a role or skill you want — "I want to be a data analyst"',
  '"why is X in my path?" or "why this order?"',
  '"how long will it take?"',
  '"what am I missing?"',
  '"what should I learn first?"',
  '"can I skip X?"',
  '"tell me about X"',
  '"quiz me on SQL"',
  '"I can do 8 hours a week"',
]

export function respond(input: string, ctx: Context): AssistantReply {
  const text = input.trim()
  const lower = text.toLowerCase()
  const { profile, path } = ctx
  const goal = getGoal(profile.goalId)

  // Resolved once: several branches below need to know whether this message
  // is really a goal statement before they claim it.
  const resolved = ctx.resolvedGoalId ? getGoal(ctx.resolvedGoalId) : undefined
  const goalMatch = resolved
    ? { goal: resolved, score: Number.POSITIVE_INFINITY }
    : matchGoal(lower)

  // ---- pace adjustment (checked first: it can accompany any message) ----
  const weekly = parseWeeklyHours(lower)
  if (weekly !== null) {
    const pace = paceForHours(weekly)
    const newWeeks = path ? Math.max(1, Math.ceil(path.totalHours / PACE_HOURS[pace])) : null
    return {
      text: newWeeks
        ? `Got it — ${weekly} hrs/week. That puts the full path at roughly ${fmtWeeks(newWeeks)}. I have updated the schedule.`
        : `Noted — ${weekly} hrs/week. Tell me your goal and I will size a path around that.`,
      intent: 'pace',
      effects: { setPace: pace },
      suggestions: path ? ['Show me the first milestone', 'Why this order?'] : GOAL_PROMPT_SUGGESTIONS,
    }
  }

  // ---- "why" questions ----
  if (/\bwhy\b/.test(lower)) {
    if (!path || !goal) {
      return {
        text: 'I have not built a path yet, so there is nothing to explain. What are you aiming for?',
        intent: 'why-nothing-planned',
        suggestions: GOAL_PROMPT_SUGGESTIONS,
      }
    }

    // Did they name a specific resource?
    const named = namedResource(lower, path)

    if (named) {
      const item = findPathItem(path, named.id)
      const reasons = item?.reasons.map((r) => `— ${r.text}`).join('\n') ?? ''
      return {
        text: `**${named.title}** is in your path for these reasons:\n${reasons}`,
        intent: 'why-item',
        attachment: { type: 'resources', ids: [named.id] },
        suggestions: [`Can I skip ${named.title}?`, 'Show the whole path'],
      }
    }

    if (/order|sequence|first|before/.test(lower)) {
      return {
        text: 'The order is driven by prerequisites, not by difficulty alone. Each resource declares the skill levels it assumes on entry, and I schedule it only once earlier items have raised you to that bar. Where several items were unblocked at the same time, I put the shorter and more foundational one first.',
        intent: 'why-order',
        suggestions: ['Show me the first milestone', 'Can I go faster?'],
      }
    }

    const gaps = skillGaps(profile, goal).filter((g) => g.gap > 0).slice(0, 4)
    return {
      text: `The path targets the gaps between where you are now and what **${goal.title}** requires. The widest ones:\n${gaps
        .map((g) => `— ${skillName(g.skillId)}: you are at ${g.current} (${LEVEL_LABELS[g.current]}), the goal needs ${g.target}.`)
        .join('\n')}`,
      intent: 'why-gaps',
      attachment: { type: 'skills', ids: gaps.map((g) => g.skillId) },
      suggestions: ['Why this order?', 'How long will it take?'],
    }
  }

  // ---- duration questions ----
  if (/how long|duration|how many weeks|when will|finish by|time/.test(lower)) {
    if (!path) {
      return {
        text: 'Tell me the goal first and I will give you a real number rather than a guess.',
        intent: 'duration',
        suggestions: GOAL_PROMPT_SUGGESTIONS,
      }
    }
    return {
      text: `${fmtHours(path.totalHours)} of content in total. At your current pace of ${PACE_HOURS[profile.pace]} hrs/week that is about ${fmtWeeks(path.weeks)}. Tell me how many hours a week you can actually give it and I will recalculate.`,
      intent: 'duration',
      suggestions: ['I can do 4 hours a week', 'I can do 15 hours a week'],
    }
  }

  // ---- skill gap questions ----
  if (/gap|what am i missing|weak|skill/.test(lower) && goal) {
    const levels = profileSkills(profile)
    const gaps = skillGaps(profile, goal, levels)
    const open = gaps.filter((g) => g.gap > 0)
    const met = gaps.filter((g) => g.gap === 0)
    return {
      text: `Against **${goal.title}** you have ${met.length} of ${gaps.length} target skills already at level.${
        open.length
          ? ` Still open:\n${open.slice(0, 5).map((g) => `— ${skillName(g.skillId)}: ${g.current} → ${g.target}`).join('\n')}`
          : ' Nothing outstanding — you are at target across the board.'
      }`,
      intent: 'gaps',
      attachment: { type: 'skills', ids: open.slice(0, 5).map((g) => g.skillId) },
      suggestions: ['Why this order?', 'Show me the path'],
    }
  }

  // ---- show the path ----
  if (/show|see|view|path|roadmap|plan|milestone|first step|start/.test(lower) && path) {
    return {
      text: pathSummaryText(path, profile),
      intent: 'path',
      attachment: { type: 'path-summary' },
      suggestions: ['Why these choices?', 'How long will it take?'],
    }
  }

  // ---- "can I skip this?" ----
  if (/\bskip\b|\bdrop\b|\bomit\b|do i (really )?(have to|need)|without (doing|taking)/.test(lower) && path) {
    const target = namedResource(lower, path)

    if (target) {
      const item = findPathItem(path, target.id)
      const order = pathResourceIds(path)
      const later = order
        .slice(order.indexOf(target.id) + 1)
        .map(getResource)
        .filter((r): r is Resource => Boolean(r))
      const unlocks = later.filter((r) =>
        Object.keys(r.requires ?? {}).some((skillId) => skillId in target.teaches),
      )
      const closes = item?.closes ?? []

      return {
        text: [
          `You can — nothing here is compulsory.`,
          closes.length
            ? `What you would give up: ${closes.map((c) => `${skillName(c.skillId)} stays at ${c.from} instead of reaching ${c.to}`).join(', ')}.`
            : 'It closes no skill gap on its own — it applies or validates what you already have.',
          unlocks.length
            ? `And ${unlocks.length === 1 ? 'one later item assumes' : `${unlocks.length} later items assume`} it: ${unlocks.slice(0, 3).map((r) => r.title).join(', ')}.`
            : 'Nothing later in the path depends on it.',
          `If you already have those skills, set them on the Profile screen or take the check on the Assessment screen — either one re-plans and drops what you no longer need.`,
        ].join(' '),
        intent: 'skip',
        attachment: { type: 'resources', ids: [target.id] },
        suggestions: [`Quiz me on ${skillName(closes[0]?.skillId ?? 'python')}`, 'Show me the path'],
      }
    }

    return {
      text: 'Name the item and I will tell you exactly what skipping it costs — which skill stays short of target, and what later on assumes it. Nothing in the path is compulsory; the ordering just tells you what breaks.',
      intent: 'skip',
      suggestions: ['Show me the path', 'What am I missing?'],
    }
  }

  // ---- "tell me about X" ----
  if (/tell me about|what is|what'?s the|explain the|more about|details on/.test(lower) && path) {
    const target = namedResource(lower, path)
    if (target) {
      const teaches = Object.entries(target.teaches)
        .map(([skillId, level]) => `${skillName(skillId)} to ${level}`)
        .join(', ')
      return {
        text: `**${target.title}** — ${target.provider}, ${fmtHours(target.hours)}, difficulty band ${target.level} of 3.\n\n${target.summary}\n\nIt takes ${teaches}.`,
        intent: 'detail',
        attachment: { type: 'resources', ids: [target.id] },
        suggestions: [`Why ${target.title}?`, `Can I skip ${target.title}?`],
      }
    }
  }

  // ---- "what should I learn first / next" ----
  if (
    /what (should|do|can) i (learn|do|study|take|start)|where (do|should) i (start|begin)|what'?s next|next step|learn first|start with/.test(
      lower,
    ) &&
    path
  ) {
    const order = pathResourceIds(path)
    const nextId = order.find((id) => !profile.completed.includes(id))
    const next = nextId ? getResource(nextId) : undefined

    if (next) {
      const position = order.indexOf(next.id) + 1
      return {
        text: `Start with **${next.title}** — step ${position} of ${order.length}, ${fmtHours(next.hours)} from ${next.provider}. It is first because every item ahead of it in the path either has unmet prerequisites or builds on this one.`,
        intent: 'next',
        attachment: { type: 'resources', ids: [next.id] },
        suggestions: [`Why ${next.title}?`, `Tell me about ${next.title}`],
      }
    }

    return {
      text: 'You have finished everything in the current path. Change the goal, or raise the target, and I will build the next stretch.',
      intent: 'next',
      suggestions: GOAL_PROMPT_SUGGESTIONS,
    }
  }

  // ---- worries about difficulty ----
  if (/too hard|too easy|too difficult|too advanced|too basic|hard for me|out of my depth|overwhelm/.test(lower) && path) {
    const order = pathResourceIds(path)
    const first = order[0] ? getResource(order[0]) : undefined
    const levels = profileSkills(profile)
    const unmet = first
      ? Object.entries(first.requires ?? {}).filter(
          ([skillId, min]) => (levels[skillId] ?? 0) < (min ?? 0),
        )
      : []

    return {
      text: [
        first
          ? `The path opens at difficulty band ${first.level} of 3 with **${first.title}**.`
          : 'The path is sized against your current levels.',
        unmet.length === 0
          ? 'You already meet its entry requirements, so it should not feel like a wall — items only get scheduled once earlier ones have raised you to the bar they assume.'
          : `It assumes ${unmet.map(([skillId]) => skillName(skillId)).join(', ')}, which you are short on — tell me and I will re-plan from a lower starting point.`,
        'If it is the opposite problem and this is beneath you, take the check on the Assessment screen: measured levels drop content you do not need.',
      ].join(' '),
      intent: 'difficulty',
      suggestions: ['I can do 4 hours a week', 'What should I learn first?'],
    }
  }

  // ---- "I already know X" ----
  if (
    /i (already )?know|i'?ve (used|done|worked)|i'?m (good|comfortable|fine|ok) (at|with)|i have (used|experience)/.test(
      lower,
    ) &&
    !goalMatch
  ) {
    const skill = namedSkill(lower)
    const levels = profileSkills(profile)
    const current = skill ? (levels[skill.id] ?? 0) : null

    return {
      text: skill
        ? `Noted — I currently have you at ${current} (${LEVEL_LABELS[current as 0]}) for **${skill.name}**, inferred from your completed courses. Two ways to change that: set it yourself on the Profile screen, or answer three questions on the Assessment screen and let it be measured. Either one re-plans the path.`
        : 'Tell me which skill and I will check what I have you at. You can set a level yourself on the Profile screen, or have it measured on the Assessment screen — either one re-plans the path.',
      intent: 'known',
      attachment: skill ? { type: 'skills', ids: [skill.id] } : undefined,
      suggestions: skill ? [`Quiz me on ${skill.name}`, 'What am I missing?'] : ['What am I missing?'],
    }
  }

  // ---- assessment ----
  if (/quiz|test me|assess|check my level|measure my|verify my/.test(lower)) {
    const skill = namedSkill(lower)
    return {
      text: skill
        ? `Open the Assessment screen and pick **${skill.name}** — three questions, graded server-side, and the result updates your level and re-plans the path. If the answers put you on the boundary it asks more rather than guessing.`
        : 'The Assessment screen has a short check for any skill in your path. Three questions, graded server-side, and the result updates your level and re-plans the path rather than editing it directly.',
      intent: 'assess',
      attachment: skill ? { type: 'skills', ids: [skill.id] } : undefined,
      suggestions: ['What am I missing?', 'Show me the path'],
    }
  }

  // ---- goal statement ----
  // A goal resolved upstream (the server's model-backed extractor) wins;
  // keyword matching is the fallback, not the only route in.
  if (goalMatch) {
    const isChange = profile.goalId && profile.goalId !== goalMatch.goal.id
    return {
      text: `${isChange ? 'Switching to' : 'Right'} — **${goalMatch.goal.title}**. ${goalMatch.goal.blurb}\n\nI have read your profile: ${
        profile.completed.length
          ? `${profile.completed.length} completed ${profile.completed.length === 1 ? 'course' : 'courses'} on record`
          : 'no completed courses yet'
      }, experience level "${profile.experience}". Building the path now.`,
      intent: 'goal',
      attachment: { type: 'path-summary' },
      effects: { setGoal: { goalId: goalMatch.goal.id, statement: text } },
      suggestions: ['Why these choices?', 'How long will it take?', 'I can do 4 hours a week'],
    }
  }

  // ---- greetings ----
  if (/^(hi|hey|hello|yo)\b/.test(lower)) {
    return {
      text: 'Hello. Describe where you want to end up — a role, a project, or a specific capability — and I will map the route from what you already know.',
      intent: 'greeting',
      suggestions: GOAL_PROMPT_SUGGESTIONS,
    }
  }

  // ---- acknowledgements ----
  if (/^(ok|okay|k|thanks|thank you|ta|cool|nice|great|got it|sure|yep|yeah|right)\b/.test(lower) && text.length < 30) {
    return {
      text: path
        ? 'Any time. The path is on the Learning path screen whenever you want it.'
        : 'Any time. Tell me the role or skill you are aiming at whenever you are ready.',
      intent: 'ack',
      suggestions: path
        ? ['What should I learn first?', 'What am I missing?']
        : GOAL_PROMPT_SUGGESTIONS,
    }
  }

  // ---- catch-all: say what I can do, rather than repeat one dead end ----
  return {
    text: [
      "I could not match that to something I can answer from your plan.",
      path
        ? 'Things I can do:'
        : 'I plan towards four tracks, and I have not got a goal from you yet. Things I can do:',
      CAPABILITIES.map((line) => `— ${line}`).join('\n'),
    ].join('\n'),
    intent: 'unmatched',
    suggestions: path
      ? ['What should I learn first?', 'What am I missing?', 'How long will it take?']
      : GOAL_PROMPT_SUGGESTIONS,
  }
}
