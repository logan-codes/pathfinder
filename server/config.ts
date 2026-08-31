/**
 * Server configuration. Every knob is an environment variable with a working
 * default, so `npm run server` needs no setup at all.
 *
 * Two decisions matter here.
 *
 * The first is which model provider answers. That is no longer one vendor:
 * any provider with a key in the environment is selectable, and the order in
 * `PATHFINDER_PROVIDERS` is the failover chain. With no key at all the server
 * is fully deterministic and every route still answers.
 *
 * The second is the ceilings. A demo that anyone can reach is a demo anyone
 * can bill, so there is a per-IP rate limit, a process-wide spend cap, and an
 * optional API key. All three are off-by-default only where being off cannot
 * cost anything.
 */

function intEnv(name: string, fallback: number, { min = 1 } = {}): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function listEnv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  return raw !== 'off' && raw !== 'false' && raw !== '0' && raw !== 'no'
}

// ---- transport ----------------------------------------------------------

export const PORT = intEnv('PORT', 8787)
export const HOST = process.env.HOST ?? '127.0.0.1'

export const CORS_ORIGINS = listEnv(
  'PATHFINDER_CORS_ORIGINS',
  'http://localhost:5173,http://127.0.0.1:5173',
)

/**
 * Behind a reverse proxy every request arrives from the proxy's address, so
 * the per-IP limiter would be one shared bucket. Only turn this on when
 * something in front of the server is actually setting X-Forwarded-For, or
 * the header becomes a trivial way to forge an identity.
 */
export const TRUST_PROXY = boolEnv('PATHFINDER_TRUST_PROXY', false)

/**
 * When set, every /api route except the index and the liveness check needs
 * `Authorization: Bearer <key>` or `x-api-key`. Unset means open, which is
 * right for localhost and wrong for anything with a public hostname.
 */
export const API_KEY = process.env.PATHFINDER_API_KEY?.trim() || null

// ---- the model layer ----------------------------------------------------

export type LlmMode = 'auto' | 'on' | 'off'

const rawMode = (process.env.PATHFINDER_LLM ?? 'auto').toLowerCase()
export const LLM_MODE: LlmMode = rawMode === 'on' || rawMode === 'off' ? rawMode : 'auto'

/**
 * The failover chain, tried left to right. Anything without a key is skipped
 * silently, so this can list every provider you might ever configure.
 */
export const PROVIDER_ORDER = listEnv(
  'PATHFINDER_PROVIDERS',
  'anthropic,openai,google,groq,mistral',
)

/**
 * On a provider failure, try the next configured provider before giving up
 * and answering deterministically. This replaces the Anthropic-specific
 * server-side refusal fallback: it is vendor-neutral and it is what makes
 * "all the keys work" demonstrable rather than asserted.
 */
export const PROVIDER_FALLBACK = boolEnv('PATHFINDER_PROVIDER_FALLBACK', true)

/**
 * Lets a caller pick the provider per request (`"provider": "openai"`).
 * On for the demo — it is how every configured key gets exercised through
 * one endpoint. Turn it off if the API is ever exposed.
 */
export const ALLOW_PROVIDER_OVERRIDE = boolEnv('PATHFINDER_ALLOW_PROVIDER_OVERRIDE', true)

/** Legacy single-model knob. Still honoured as the Anthropic default. */
export const MODEL = process.env.PATHFINDER_MODEL ?? null

export function providerModelOverride(envName: string): string | null {
  const specific = process.env[envName]?.trim()
  if (specific) return specific
  // PATHFINDER_MODEL predates the registry, so it only speaks for Anthropic.
  if (envName === 'PATHFINDER_MODEL_ANTHROPIC' && MODEL) return MODEL
  return null
}

/**
 * Per-provider price overrides, as PATHFINDER_PRICE_OPENAI="0.4,1.6" in USD
 * per million tokens (input, output). Only ever used for the local spend
 * ceiling — nothing here is a bill.
 */
export const PRICE_OVERRIDES: Record<string, { input: number; output: number } | undefined> =
  Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith('PATHFINDER_PRICE_'))
      .flatMap((key) => {
        const [input, output] = (process.env[key] ?? '').split(',').map(Number)
        if (!Number.isFinite(input) || !Number.isFinite(output)) return []
        const id = key.slice('PATHFINDER_PRICE_'.length).toLowerCase()
        return [[id, { input, output }] as const]
      }),
  )

/**
 * Hard ceiling on any single model call. A judge's wifi that hangs must cost
 * us a few seconds, not the demo — after this we fall back.
 */
export const LLM_TIMEOUT_MS = intEnv('PATHFINDER_LLM_TIMEOUT_MS', 8000)

/** Retries sit inside the timeout, so keep them at zero or one. */
export const LLM_MAX_RETRIES = intEnv('PATHFINDER_LLM_MAX_RETRIES', 0, { min: 0 })

/** Below this the model's own answer is not trusted; keywords decide instead. */
export const EXTRACTION_CONFIDENCE_FLOOR = floatEnv('PATHFINDER_CONFIDENCE_FLOOR', 0.55)

// ---- ceilings -----------------------------------------------------------

/** Requests per window, per IP, on the routes that can spend money. */
export const LLM_RATE_LIMIT = intEnv('PATHFINDER_LLM_RATE_LIMIT', 30)
export const LLM_RATE_WINDOW_MS = intEnv('PATHFINDER_LLM_RATE_WINDOW_MS', 60_000)

/**
 * Process-wide spend caps. Zero disables a cap individually. These are the
 * control the rate limiter never was: the limiter bounds one client, these
 * bound the bill. Hitting one degrades to deterministic answers, silently to
 * the caller and loudly in /api/health.
 */
export const BUDGET_MAX_CALLS = intEnv('PATHFINDER_BUDGET_MAX_CALLS', 500, { min: 0 })
export const BUDGET_MAX_TOKENS = intEnv('PATHFINDER_BUDGET_MAX_TOKENS', 2_000_000, { min: 0 })
export const BUDGET_MAX_USD = floatEnv('PATHFINDER_BUDGET_MAX_USD', 5)
/** Zero means the counters run for the life of the process. */
export const BUDGET_WINDOW_MS = intEnv('PATHFINDER_BUDGET_WINDOW_MS', 0, { min: 0 })

// ---- screening ----------------------------------------------------------

export type InjectionPolicy = 'deterministic' | 'sanitize'

/**
 * What to do with a message that looks like a prompt-injection attempt.
 * `deterministic` takes the model out of the loop for that message, which
 * costs nothing because the rules always have an answer. `sanitize` keeps
 * the model, relying on the fence and the output checks alone.
 */
export const INJECTION_POLICY: InjectionPolicy =
  (process.env.PATHFINDER_INJECTION_POLICY ?? '').toLowerCase() === 'sanitize'
    ? 'sanitize'
    : 'deterministic'

/**
 * Extra substrings that route a message to the deterministic path. Deliberately
 * empty by default and left to the operator: a wordlist baked into the source
 * is a wordlist nobody can tune for their own learners.
 */
export const EXTRA_BLOCK_TERMS = listEnv('PATHFINDER_BLOCK_TERMS', '')

/** Prose ceilings, enforced on model output rather than merely requested. */
export const MAX_REPLY_SENTENCES = intEnv('PATHFINDER_MAX_REPLY_SENTENCES', 4)
export const MAX_REPLY_CHARS = intEnv('PATHFINDER_MAX_REPLY_CHARS', 900)
export const MAX_NARRATION_SENTENCES = intEnv('PATHFINDER_MAX_NARRATION_SENTENCES', 4)
export const MAX_NARRATION_CHARS = intEnv('PATHFINDER_MAX_NARRATION_CHARS', 700)
