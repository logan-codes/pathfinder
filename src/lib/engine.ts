/**
 * Recommendation engine.
 *
 * Deterministic and synchronous today; the exported functions are the
 * seam where a real service drops in. Nothing in here touches React.
 *
 * Pipeline:
 *   1. profileSkills  — derive current levels from history + self-rating
 *   2. skillGaps      — diff against the goal's target profile
 *   3. selectItems    — greedily pick resources that close weighted gaps
 *   4. orderItems     — sort so prerequisites land before dependants
 *   5. buildPath      — group into milestones, attach explanations
 */

import { RESOURCES, getResource, skillName } from './catalog.js'
import { getGoal } from './goals.js'
import {
  PACE_HOURS,
  type Goal,
  type LearnerProfile,
  type LearningPath,
  type Level,
  type Milestone,
  type PathItem,
  type Reason,
  type Resource,
  type SkillId,
} from './types.js'

const clampLevel = (n: number): Level => Math.max(0, Math.min(5, Math.round(n))) as Level

/** Baseline level granted by the learner's self-declared experience. */
const EXPERIENCE_FLOOR: Record<LearnerProfile['experience'], number> = {
  beginner: 0,
  some: 1,
  experienced: 2,
}

/**
 * Step 1 — current skill levels.
 * History wins over self-rating when it implies more, since completing a
 * resource is stronger evidence than a self-assessment.
 */
export function profileSkills(profile: LearnerProfile): Record<SkillId, Level> {
  const levels: Record<SkillId, Level> = {}
  const floor = EXPERIENCE_FLOOR[profile.experience]

  for (const id of profile.completed) {
    const resource = getResource(id)
    if (!resource) continue
    for (const [skillId, taught] of Object.entries(resource.teaches)) {
      const current = levels[skillId] ?? 0
      levels[skillId] = clampLevel(Math.max(current, taught ?? 0))
    }
  }

  for (const [skillId, rated] of Object.entries(profile.selfRated)) {
    if (rated == null) continue
    levels[skillId] = clampLevel(Math.max(levels[skillId] ?? 0, rated))
  }

  // The experience floor only lifts skills the learner has already touched.
  for (const skillId of Object.keys(levels)) {
    levels[skillId] = clampLevel(Math.max(levels[skillId], floor))
  }

  return levels
}

export interface SkillGap {
  skillId: SkillId
  current: Level
  target: Level
  gap: number
  weight: number
}

/** Step 2 — where the learner stands against the goal. */
export function skillGaps(
  profile: LearnerProfile,
  goal: Goal,
  levels = profileSkills(profile),
): SkillGap[] {
  return Object.entries(goal.target)
    .map(([skillId, target]) => {
      const current = levels[skillId] ?? 0
      const t = (target ?? 0) as Level
      return {
        skillId,
        current,
        target: t,
        gap: Math.max(0, t - current),
        weight: goal.weights?.[skillId] ?? 1,
      }
    })
    .sort((a, b) => b.gap * b.weight - a.gap * a.weight)
}

/** How well a resource's difficulty suits the learner right now. */
function levelFit(resource: Resource, levels: Record<SkillId, Level>): number {
  const required = Object.entries(resource.requires ?? {})
  if (required.length === 0) return 1

  let unmet = 0
  for (const [skillId, min] of required) {
    const have = levels[skillId] ?? 0
    if (have < (min ?? 0)) unmet += (min ?? 0) - have
  }
  // Slightly out of reach is fine (prerequisites get scheduled first);
  // wildly out of reach is penalised hard.
  if (unmet === 0) return 1
  if (unmet <= 2) return 0.7
  return 0.25
}

function interestBonus(resource: Resource, interests: string[]): number {
  if (interests.length === 0) return 0
  const tags = resource.tags ?? []
  const hits = tags.filter((t) => interests.includes(t)).length
  return hits * 0.6
}

/**
 * Step 3 — greedy selection.
 * Each round picks the resource with the best marginal value against the
 * gaps that are still open, then updates the running skill state.
 */
function selectItems(
  profile: LearnerProfile,
  goal: Goal,
  levels: Record<SkillId, Level>,
): { chosen: Resource[]; projected: Record<SkillId, Level> } {
  const projected: Record<SkillId, Level> = { ...levels }
  const chosen: Resource[] = []
  const done = new Set(profile.completed)

  // Guard rail: a path longer than this stops being a plan and starts
  // being a catalogue dump.
  const MAX_ITEMS = 12

  for (let round = 0; round < MAX_ITEMS; round++) {
    const openGaps = skillGaps(profile, goal, projected).filter((g) => g.gap > 0)
    if (openGaps.length === 0) break

    const gapByskill = new Map(openGaps.map((g) => [g.skillId, g]))
    let best: { resource: Resource; score: number } | null = null

    for (const resource of RESOURCES) {
      if (done.has(resource.id)) continue
      if (chosen.some((c) => c.id === resource.id)) continue

      let value = 0
      for (const [skillId, taught] of Object.entries(resource.teaches)) {
        const gap = gapByskill.get(skillId)
        if (!gap) continue
        const have = projected[skillId] ?? 0
        const delta = Math.min((taught ?? 0), gap.target) - have
        if (delta > 0) value += delta * gap.weight
      }

      // An assessment closes no gap but validates a skill the learner is
      // about to claim, so give it a small standing value once its
      // prerequisite is met.
      if (resource.kind === 'assessment' && value === 0) {
        const ready = Object.entries(resource.requires ?? {}).every(
          ([skillId, min]) => (projected[skillId] ?? 0) >= (min ?? 0),
        )
        if (ready && Object.keys(resource.requires ?? {}).some((s) => goal.target[s])) {
          value = 0.5
        }
      }

      if (value <= 0) continue

      const score =
        value * levelFit(resource, projected) +
        interestBonus(resource, profile.interests) -
        resource.hours / 100 // mild preference for the shorter route

      if (!best || score > best.score) best = { resource, score }
    }

    if (!best) break

    chosen.push(best.resource)
    for (const [skillId, taught] of Object.entries(best.resource.teaches)) {
      projected[skillId] = clampLevel(Math.max(projected[skillId] ?? 0, taught ?? 0))
    }
  }

  return { chosen, projected }
}

/**
 * Step 4 — prerequisite-aware ordering.
 * Repeatedly emit whichever remaining resource has its requirements met by
 * the running state, tie-broken by difficulty band. Falls back to the
 * easiest remaining item if a cycle or unsatisfiable requirement appears,
 * so this always terminates.
 */
function orderItems(chosen: Resource[], startLevels: Record<SkillId, Level>): Resource[] {
  const running: Record<SkillId, Level> = { ...startLevels }
  const remaining = [...chosen]
  const ordered: Resource[] = []

  const ready = (r: Resource) =>
    Object.entries(r.requires ?? {}).every(
      ([skillId, min]) => (running[skillId] ?? 0) >= (min ?? 0),
    )

  while (remaining.length > 0) {
    const candidates = remaining.filter(ready)
    const pool = candidates.length > 0 ? candidates : remaining

    pool.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level
      // Courses before the project/assessment that validates them.
      const rank = { course: 0, project: 1, assessment: 2 } as const
      if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind]
      return a.hours - b.hours
    })

    const next = pool[0]
    ordered.push(next)
    remaining.splice(remaining.indexOf(next), 1)
    for (const [skillId, taught] of Object.entries(next.teaches)) {
      running[skillId] = clampLevel(Math.max(running[skillId] ?? 0, taught ?? 0))
    }
  }

  return ordered
}

/**
 * Step 5b — the explanation layer.
 * Every reason is derived from the same numbers that drove selection, so
 * the panel can never drift from the actual decision.
 */
function explain(
  resource: Resource,
  goal: Goal,
  before: Record<SkillId, Level>,
  profile: LearnerProfile,
  laterItems: Resource[],
): { reasons: Reason[]; closes: PathItem['closes'] } {
  const reasons: Reason[] = []
  const closes: PathItem['closes'] = []

  for (const [skillId, taught] of Object.entries(resource.teaches)) {
    const target = goal.target[skillId]
    if (!target) continue
    const from = before[skillId] ?? 0
    const to = clampLevel(Math.min(taught ?? 0, 5))
    if (to > from) {
      closes.push({ skillId, from, to })
      reasons.push({
        kind: 'gap',
        text: `Moves ${skillName(skillId)} from ${from} to ${to}. Your goal needs ${target}.`,
      })
    }
  }

  // Is this a prerequisite for something later in the path?
  const unlocks = laterItems.filter((later) =>
    Object.keys(later.requires ?? {}).some((skillId) => skillId in resource.teaches),
  )
  if (unlocks.length > 0) {
    const names = unlocks.slice(0, 2).map((u) => u.title).join(', ')
    reasons.push({
      kind: 'prereq',
      text: `Required before ${names}${unlocks.length > 2 ? ` and ${unlocks.length - 2} more` : ''}.`,
    })
  }

  const matchedInterests = (resource.tags ?? []).filter((t) => profile.interests.includes(t))
  if (matchedInterests.length > 0) {
    reasons.push({
      kind: 'interest',
      text: `Matches your stated interest in ${matchedInterests.join(' and ')}.`,
    })
  }

  // Did the learner's history make this the right level rather than a lower one?
  const met = Object.entries(resource.requires ?? {}).filter(
    ([skillId, min]) => (before[skillId] ?? 0) >= (min ?? 0),
  )
  if (met.length > 0 && profile.completed.length > 0) {
    reasons.push({
      kind: 'history',
      text: `You already meet the entry bar (${met
        .map(([s]) => skillName(s))
        .join(', ')}), so the introductory alternatives were skipped.`,
    })
  }

  if (resource.kind === 'assessment') {
    reasons.push({
      kind: 'goal',
      text: 'Validates the skill before you claim it on a CV or in an interview.',
    })
  }
  if (resource.kind === 'project') {
    reasons.push({
      kind: 'goal',
      text: 'Applied work — produces something concrete for your portfolio.',
    })
  }

  return { reasons, closes }
}

/** Milestone titles are derived from what the group actually contains. */
function milestoneTitle(items: Resource[], index: number, total: number): string {
  const hasProject = items.some((i) => i.kind === 'project')
  const isLast = index === total - 1

  if (index === 0) return 'Establish foundations'
  if (hasProject && isLast) return 'Prove it end to end'
  if (hasProject) return 'Apply it on real work'
  if (isLast) return 'Reach target level'
  if (items.every((i) => i.level >= 3)) return 'Go deep'
  return 'Build core capability'
}

function milestoneOutcome(items: Resource[], goal: Goal): string {
  const skills = new Set<SkillId>()
  for (const item of items) {
    for (const skillId of Object.keys(item.teaches)) {
      if (goal.target[skillId]) skills.add(skillId)
    }
  }
  const names = Array.from(skills).map(skillName)
  if (names.length === 0) return 'Consolidate what you have covered so far.'
  const shown = names.slice(0, 3).join(', ')
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : ''
  return `By the end you can work independently in ${shown}${rest}.`
}

/** Step 5 — assemble the path. */
export function buildPath(profile: LearnerProfile): LearningPath | null {
  const goal = getGoal(profile.goalId)
  if (!goal) return null

  const levels = profileSkills(profile)
  const { chosen } = selectItems(profile, goal, levels)
  const ordered = orderItems(chosen, levels)

  // Walk the ordered list, tracking state so explanations reflect what the
  // learner will actually know when they reach each item.
  const running: Record<SkillId, Level> = { ...levels }
  const pathItems: PathItem[] = ordered.map((resource, i) => {
    const before = { ...running }
    const { reasons, closes } = explain(
      resource,
      goal,
      before,
      profile,
      ordered.slice(i + 1),
    )
    for (const [skillId, taught] of Object.entries(resource.teaches)) {
      running[skillId] = clampLevel(Math.max(running[skillId] ?? 0, taught ?? 0))
    }
    return { resourceId: resource.id, reasons, closes }
  })

  // Chunk into 3–4 milestones of roughly equal weight.
  const milestoneCount = Math.min(4, Math.max(2, Math.ceil(ordered.length / 3)))
  const perMilestone = Math.ceil(ordered.length / milestoneCount)
  const milestones: Milestone[] = []

  for (let i = 0; i < milestoneCount; i++) {
    const slice = pathItems.slice(i * perMilestone, (i + 1) * perMilestone)
    if (slice.length === 0) continue
    const resources = slice
      .map((item) => getResource(item.resourceId))
      .filter((r): r is Resource => Boolean(r))

    const entryRequirements = Array.from(
      new Set(resources.flatMap((r) => Object.keys(r.requires ?? {}))),
    ).filter((skillId) => !resources.some((r) => skillId in r.teaches))

    milestones.push({
      id: `m${i + 1}`,
      title: milestoneTitle(resources, i, milestoneCount),
      outcome: milestoneOutcome(resources, goal),
      items: slice,
      entryRequirements,
    })
  }

  const totalHours = ordered.reduce((sum, r) => sum + r.hours, 0)
  const weeklyHours = PACE_HOURS[profile.pace]

  const uncovered = skillGaps(profile, goal, running)
    .filter((g) => g.gap > 0)
    .map((g) => ({ skillId: g.skillId, from: g.current, target: g.target }))

  return {
    goalId: goal.id,
    milestones,
    totalHours,
    weeks: Math.max(1, Math.ceil(totalHours / weeklyHours)),
    uncovered,
    generatedAt: Date.now(),
  }
}

/** Flatten a path back to an ordered resource id list. */
export function pathResourceIds(path: LearningPath | null): string[] {
  if (!path) return []
  return path.milestones.flatMap((m) => m.items.map((i) => i.resourceId))
}

/** Find the explanation for one item without re-running generation. */
export function findPathItem(path: LearningPath | null, resourceId: string): PathItem | undefined {
  if (!path) return undefined
  for (const milestone of path.milestones) {
    const hit = milestone.items.find((i) => i.resourceId === resourceId)
    if (hit) return hit
  }
  return undefined
}
