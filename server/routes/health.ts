/**
 * One place to see whether this server is actually doing what it claims.
 *
 * `llm.lastError` matters most: a silent fallback is the failure mode that
 * hurts, because everything still responds and nobody notices the model has
 * been out of the loop since the first request.
 */

import { Router } from 'express'
import { RESOURCES, SKILLS } from '../../src/lib/catalog'
import { GOALS } from '../../src/lib/goals'
import { LLM_MODE, LLM_TIMEOUT_MS, USE_REFUSAL_FALLBACKS } from '../config'
import { llmStatus } from '../llm'
import { bankMeta } from '../quiz'

export const healthRouter = Router()

const startedAt = Date.now()

healthRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    startedAt,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    llm: {
      ...llmStatus,
      mode: LLM_MODE,
      timeoutMs: LLM_TIMEOUT_MS,
      refusalFallbacks: USE_REFUSAL_FALLBACKS,
    },
    catalog: { skills: SKILLS.length, resources: RESOURCES.length, goals: GOALS.length },
    quiz: bankMeta,
  })
})
