/**
 * The assessment item bank.
 *
 * Items are authored offline and committed (`data/quiz-bank.json`), and
 * imported as a module rather than read from disk: a bundler then carries
 * the bank inside the build, so there is no path to resolve at runtime and
 * no deployment that can boot without its questions. This module only reads
 * them. Generating questions per request would destroy the
 * properties that make an assessment worth having — items could not be
 * compared across learners, calibrated for difficulty from response data, or
 * A/B tested, and no human would ever have reviewed the answer keys.
 *
 * Answer keys never leave this module: items are served without them and
 * graded here.
 */

import { z } from 'zod'
import type { GradedItem } from './mastery'
import bankJson from '../data/quiz-bank.json' with { type: 'json' }

const QuizOptionSchema = z.object({
  id: z.string().min(1).max(8),
  text: z.string().min(1),
})

const QuizItemSchema = z
  .object({
    id: z.string().min(1),
    skillId: z.string().min(1),
    /** Answerable by a learner at level >= difficulty. */
    difficulty: z.number().int().min(1).max(5),
    stem: z.string().min(1),
    options: z.array(QuizOptionSchema).min(2).max(6),
    answer: z.string().min(1),
    rationale: z.string().default(''),
    reviewed: z.boolean().default(false),
  })
  .refine((item) => item.options.some((o) => o.id === item.answer), {
    message: 'answer must match one of the option ids',
  })

const QuizBankSchema = z.object({
  version: z.number().int().min(1),
  authoredAt: z.string().optional(),
  authoredBy: z.string().optional(),
  items: z.array(QuizItemSchema).min(1),
})

export type QuizItem = z.infer<typeof QuizItemSchema>

/** What a client is allowed to see: everything except the key. */
export interface ServedItem {
  id: string
  skillId: string
  difficulty: number
  stem: string
  options: Array<{ id: string; text: string }>
}

function loadBank() {
  const parsed = QuizBankSchema.safeParse(bankJson)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `Quiz bank is malformed at ${first?.path.join('.') ?? '(root)'}: ${first?.message}`,
    )
  }

  const seen = new Set<string>()
  for (const item of parsed.data.items) {
    if (seen.has(item.id)) throw new Error(`Quiz bank has a duplicate item id: ${item.id}`)
    seen.add(item.id)
  }

  return parsed.data
}

const bank = loadBank()

const byId = new Map(bank.items.map((item) => [item.id, item]))

const bySkill = new Map<string, QuizItem[]>()
for (const item of bank.items) {
  const list = bySkill.get(item.skillId)
  if (list) list.push(item)
  else bySkill.set(item.skillId, [item])
}

export const bankMeta = {
  version: bank.version,
  authoredAt: bank.authoredAt ?? null,
  authoredBy: bank.authoredBy ?? null,
  items: bank.items.length,
  skills: [...bySkill.keys()].sort(),
  unreviewed: bank.items.filter((item) => !item.reviewed).map((item) => item.id),
}

export function coverage(): Array<{ skillId: string; items: number }> {
  return [...bySkill.entries()]
    .map(([skillId, items]) => ({ skillId, items: items.length }))
    .sort((a, b) => a.skillId.localeCompare(b.skillId))
}

export function hasSkill(skillId: string): boolean {
  return bySkill.has(skillId)
}

// ---- deterministic shuffling -------------------------------------------
// Same seed, same questions in the same order. A rehearsal is reproducible,
// and two learners on the same seed get a comparable quiz.

function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}

function rngFrom(seed: string): () => number {
  let a = hashSeed(seed)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Pick a spread of difficulties rather than a random handful. Three items
 * that are all easy tell you almost nothing about where someone actually is.
 */
export function itemsForSkill(
  skillId: string,
  options: { count: number; seed: string; exclude?: readonly string[] },
): ServedItem[] {
  const all = bySkill.get(skillId)
  if (!all || all.length === 0) return []

  // Used when a first round was inconclusive and we need fresh questions.
  const skip = new Set(options.exclude ?? [])
  const pool = skip.size > 0 ? all.filter((item) => !skip.has(item.id)) : all
  if (pool.length === 0) return []

  const rng = rngFrom(`${options.seed}:${skillId}`)

  const buckets = new Map<number, QuizItem[]>()
  for (const item of pool) {
    const list = buckets.get(item.difficulty)
    if (list) list.push(item)
    else buckets.set(item.difficulty, [item])
  }

  const ordered = [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((difficulty) => shuffled(buckets.get(difficulty)!, rng))

  // Round-robin across difficulty bands until we have enough.
  const picked: QuizItem[] = []
  for (let round = 0; picked.length < options.count; round++) {
    let tookOne = false
    for (const band of ordered) {
      if (round < band.length) {
        picked.push(band[round])
        tookOne = true
        if (picked.length === options.count) break
      }
    }
    if (!tookOne) break
  }

  return picked.map((item) => ({
    id: item.id,
    skillId: item.skillId,
    difficulty: item.difficulty,
    stem: item.stem,
    // Option ids stay stable, only their order moves, so grading never
    // depends on the client sending the same seed back.
    options: shuffled(item.options, rngFrom(`${options.seed}:${item.id}`)).map((o) => ({
      id: o.id,
      text: o.text,
    })),
  }))
}

export interface GradeDetail {
  itemId: string
  difficulty: number
  correct: boolean
  chosenOptionId: string
  correctOptionId: string
  rationale: string
}

export interface GradeResult {
  details: GradeDetail[]
  graded: GradedItem[]
  /** Item ids that are not in the bank, or belong to another skill. */
  rejected: string[]
}

export function gradeAnswers(
  skillId: string,
  answers: Array<{ itemId: string; optionId: string }>,
): GradeResult {
  const details: GradeDetail[] = []
  const rejected: string[] = []

  for (const answer of answers) {
    const item = byId.get(answer.itemId)
    if (!item || item.skillId !== skillId) {
      rejected.push(answer.itemId)
      continue
    }
    details.push({
      itemId: item.id,
      difficulty: item.difficulty,
      correct: answer.optionId === item.answer,
      chosenOptionId: answer.optionId,
      correctOptionId: item.answer,
      rationale: item.rationale,
    })
  }

  return {
    details,
    graded: details.map((d) => ({ difficulty: d.difficulty, correct: d.correct })),
    rejected,
  }
}
