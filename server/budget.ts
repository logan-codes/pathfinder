/**
 * The spend ceiling.
 *
 * The per-IP rate limiter stops one client hammering the API. It does
 * nothing about a hundred clients, or about one expensive call, which is why
 * it was never the budget control it was mistaken for. This is: a hard
 * process-wide cap on calls, tokens and estimated cost, checked before every
 * model call and updated after it.
 *
 * Exceeding the budget is not an error the caller sees. It lands in the same
 * place as a timeout or a refusal — the deterministic answer — because a
 * demo that quietly costs nothing is better than a demo that 500s.
 *
 * In-process and non-persistent, which is right for a single-node demo and
 * wrong for a fleet. Behind more than one instance this becomes a shared
 * counter in Redis; the interface does not change.
 */

import { BUDGET_MAX_CALLS, BUDGET_MAX_TOKENS, BUDGET_MAX_USD, BUDGET_WINDOW_MS } from './config'

export interface UsageEntry {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  usd: number
}

interface Counters {
  calls: number
  inputTokens: number
  outputTokens: number
  usd: number
}

function empty(): Counters {
  return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 }
}

let window = { startedAt: Date.now(), ...empty() }
const byProvider = new Map<string, Counters>()

export class BudgetExceededError extends Error {
  readonly limit: string

  constructor(limit: string, detail: string) {
    super(`budget exhausted: ${limit} (${detail})`)
    this.name = 'BudgetExceededError'
    this.limit = limit
  }
}

/**
 * A rolling window, reset lazily. Zero means "no window" — the counters run
 * for the life of the process, which is what a judged demo wants.
 */
function rollIfDue(): void {
  if (BUDGET_WINDOW_MS <= 0) return
  if (Date.now() - window.startedAt < BUDGET_WINDOW_MS) return
  window = { startedAt: Date.now(), ...empty() }
  byProvider.clear()
}

/**
 * Called before a model call. Throws when the next call would take us past a
 * ceiling; every caller turns that into a deterministic answer.
 */
export function assertWithinBudget(): void {
  rollIfDue()

  if (BUDGET_MAX_CALLS > 0 && window.calls >= BUDGET_MAX_CALLS) {
    throw new BudgetExceededError('calls', `${window.calls}/${BUDGET_MAX_CALLS}`)
  }

  const tokens = window.inputTokens + window.outputTokens
  if (BUDGET_MAX_TOKENS > 0 && tokens >= BUDGET_MAX_TOKENS) {
    throw new BudgetExceededError('tokens', `${tokens}/${BUDGET_MAX_TOKENS}`)
  }

  if (BUDGET_MAX_USD > 0 && window.usd >= BUDGET_MAX_USD) {
    throw new BudgetExceededError('usd', `${window.usd.toFixed(4)}/${BUDGET_MAX_USD}`)
  }
}

/**
 * Called after a model call, successful or not. A call that failed still
 * consumed input tokens on most providers, so it still counts.
 */
export function recordUsage(entry: UsageEntry): void {
  rollIfDue()

  window.calls += 1
  window.inputTokens += entry.inputTokens
  window.outputTokens += entry.outputTokens
  window.usd += entry.usd

  const current = byProvider.get(entry.provider) ?? empty()
  current.calls += 1
  current.inputTokens += entry.inputTokens
  current.outputTokens += entry.outputTokens
  current.usd += entry.usd
  byProvider.set(entry.provider, current)
}

const round = (value: number): number => Math.round(value * 10000) / 10000

/** What `/api/health` shows, so a judge can see the ceiling and the burn. */
export function budgetReport() {
  rollIfDue()

  return {
    windowMs: BUDGET_WINDOW_MS,
    windowStartedAt: window.startedAt,
    limits: {
      calls: BUDGET_MAX_CALLS || null,
      tokens: BUDGET_MAX_TOKENS || null,
      usd: BUDGET_MAX_USD || null,
    },
    used: {
      calls: window.calls,
      inputTokens: window.inputTokens,
      outputTokens: window.outputTokens,
      usd: round(window.usd),
    },
    remaining: {
      calls: BUDGET_MAX_CALLS > 0 ? Math.max(0, BUDGET_MAX_CALLS - window.calls) : null,
      tokens:
        BUDGET_MAX_TOKENS > 0
          ? Math.max(0, BUDGET_MAX_TOKENS - window.inputTokens - window.outputTokens)
          : null,
      usd: BUDGET_MAX_USD > 0 ? round(Math.max(0, BUDGET_MAX_USD - window.usd)) : null,
    },
    byProvider: Object.fromEntries(
      [...byProvider.entries()].map(([provider, counters]) => [
        provider,
        { ...counters, usd: round(counters.usd) },
      ]),
    ),
  }
}

/** Test and rehearsal hook. Never wired to a route. */
export function resetBudget(): void {
  window = { startedAt: Date.now(), ...empty() }
  byProvider.clear()
}
