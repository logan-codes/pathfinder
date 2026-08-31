/**
 * Which model providers this deployment can actually use, and proof.
 *
 * `GET /api/providers` is configuration: what is registered, which keys are
 * present, which model each would use, and what the failover order is. It
 * costs nothing and calls nobody.
 *
 * `POST /api/providers/check` is evidence: one real, minimal call per
 * configured provider, reporting ok/failed and a latency. That distinction
 * matters — a key in an environment variable is not a working key, and the
 * only way to tell the difference is to spend a token finding out.
 *
 * Neither route ever returns a key. `keyFingerprint` is eight hex characters
 * of a SHA-256 digest, enough to confirm which key is loaded and useless for
 * anything else.
 */

import { Router } from 'express'
import { z } from 'zod'
import { assertWithinBudget, budgetReport, BudgetExceededError, recordUsage } from '../budget'
import { ALLOW_PROVIDER_OVERRIDE, LLM_MODE, PROVIDER_FALLBACK } from '../config'
import { asyncHandler, HttpError, parseBody } from '../http'
import {
  checkProvider,
  configuredProviders,
  isProviderId,
  llmEnabled,
  providerStatuses,
  resolveChain,
  type ProviderId,
} from '../providers'

export const providersRouter = Router()

providersRouter.get('/providers', (_req, res) => {
  res.json({
    enabled: llmEnabled(),
    mode: LLM_MODE,
    /** The order a call actually walks, given the keys present right now. */
    chain: resolveChain(),
    failover: PROVIDER_FALLBACK,
    perRequestOverride: ALLOW_PROVIDER_OVERRIDE,
    providers: providerStatuses(),
    budget: budgetReport(),
  })
})

const CheckRequest = z.object({
  /** Omit to check every provider that has a key. */
  providers: z.array(z.string().max(40)).max(10).optional(),
})

providersRouter.post(
  '/providers/check',
  asyncHandler(async (req, res) => {
    const { providers } = parseBody(CheckRequest, req.body ?? {})

    let targets: ProviderId[]
    if (providers && providers.length > 0) {
      const unknown = providers.filter((id) => !isProviderId(id))
      if (unknown.length > 0) {
        throw new HttpError(400, 'unknown_provider', `Not a known provider: ${unknown.join(', ')}`, {
          known: providerStatuses().map((status) => status.id),
        })
      }
      targets = providers.filter(isProviderId)
    } else {
      targets = configuredProviders()
    }

    if (targets.length === 0) {
      res.json({
        checked: [],
        summary: { total: 0, ok: 0, failed: 0 },
        note: 'No provider has a key in the environment, so there was nothing to check.',
        budget: budgetReport(),
      })
      return
    }

    // Sequential on purpose. Firing five providers at once to prove they work
    // is a good way to hit five rate limits and prove the opposite.
    const checked = []
    for (const id of targets) {
      try {
        assertWithinBudget()
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          checked.push({
            id,
            model: null,
            ok: false,
            latencyMs: 0,
            error: `skipped: ${error.message}`,
          })
          continue
        }
        throw error
      }

      const result = await checkProvider(id)
      // A liveness ping is small but not free, and it counts like anything else.
      recordUsage({
        provider: id,
        model: result.model,
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
      })
      checked.push(result)
    }

    const ok = checked.filter((result) => result.ok).length
    res.json({
      checked,
      summary: { total: checked.length, ok, failed: checked.length - ok },
      budget: budgetReport(),
    })
  }),
)
