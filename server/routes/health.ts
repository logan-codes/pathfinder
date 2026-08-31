/**
 * One place to see whether this server is actually doing what it claims.
 *
 * `llm.lastError` matters most: a silent fallback is the failure mode that
 * hurts, because everything still responds and nobody notices the model has
 * been out of the loop since the first request. `guardrailBlocks` and
 * `screened` are the same idea for the guardrails — a guardrail nobody can
 * see firing is indistinguishable from one that does not work.
 *
 * When an API key is configured, an unauthenticated caller gets liveness and
 * nothing else. Error strings and spend figures are operational detail.
 */

import { Router } from 'express'
import { RESOURCES, SKILLS } from '../../src/lib/catalog.js'
import { GOALS } from '../../src/lib/goals.js'
import { budgetReport } from '../budget.js'
import { API_KEY, INJECTION_POLICY, LLM_MODE, LLM_RATE_LIMIT, LLM_TIMEOUT_MS } from '../config.js'
import { isAuthenticated } from '../http.js'
import { llmStatus } from '../llm.js'
import { llmEnabled, providerStatuses, resolveChain } from '../providers.js'
import { bankMeta } from '../quiz.js'

export const healthRouter = Router()

const startedAt = Date.now()

healthRouter.get('/health', (req, res) => {
  const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000)

  if (!isAuthenticated(req)) {
    res.json({ ok: true, uptimeSeconds, authRequired: true })
    return
  }

  res.json({
    ok: true,
    startedAt,
    uptimeSeconds,
    auth: { required: API_KEY !== null },
    llm: {
      ...llmStatus,
      enabled: llmEnabled(),
      mode: LLM_MODE,
      timeoutMs: LLM_TIMEOUT_MS,
      chain: resolveChain(),
      providers: providerStatuses(),
    },
    budget: budgetReport(),
    guardrails: {
      injectionPolicy: INJECTION_POLICY,
      rateLimitPerWindow: LLM_RATE_LIMIT,
      /** Inbound messages diverted from the model by screening. */
      screened: llmStatus.screened,
      /** Model answers discarded for failing an output check. */
      outputsRejected: llmStatus.guardrailBlocks,
      lastViolations: llmStatus.lastViolations,
    },
    catalog: { skills: SKILLS.length, resources: RESOURCES.length, goals: GOALS.length },
    quiz: bankMeta,
  })
})
