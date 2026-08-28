/**
 * Server configuration. Every knob is an environment variable with a
 * working default, so `npm run server` needs no setup at all.
 *
 * The one decision that matters here is `LLM_ENABLED`. The demo has to run
 * with the network unplugged, so the LLM is opt-in by evidence: it is only
 * used when credentials are actually present, and every route that touches
 * it has a deterministic fallback behind it.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const PORT = intEnv('PORT', 8787)
export const HOST = process.env.HOST ?? '127.0.0.1'

/** Model used at both LLM edges. Override for a cheaper rehearsal run. */
export const MODEL = process.env.PATHFINDER_MODEL ?? 'claude-opus-5'

/**
 * Hard ceiling on any single model call. A judge's wifi that hangs must
 * cost us a few seconds, not the demo — after this we fall back.
 */
export const LLM_TIMEOUT_MS = intEnv('PATHFINDER_LLM_TIMEOUT_MS', 8000)

/** Retries are on top of the timeout, so keep them low. */
export const LLM_MAX_RETRIES = intEnv('PATHFINDER_LLM_MAX_RETRIES', 1)

export type LlmMode = 'auto' | 'on' | 'off'

const rawMode = (process.env.PATHFINDER_LLM ?? 'auto').toLowerCase()
export const LLM_MODE: LlmMode = rawMode === 'on' || rawMode === 'off' ? rawMode : 'auto'

/**
 * The SDK can also authenticate from an `ant auth login` profile on disk,
 * which we cannot cheaply detect from here. `auto` therefore means "use the
 * model if an API key is in the environment"; `on` forces the attempt and
 * lets the SDK resolve credentials however it likes (still falling back if
 * that fails), and `off` guarantees a fully offline server.
 */
const hasEnvCredentials = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
)

export const LLM_ENABLED = LLM_MODE === 'on' || (LLM_MODE === 'auto' && hasEnvCredentials)

/**
 * Server-side refusal fallbacks. On a policy decline the API re-runs the
 * request on another model inside the same call instead of stopping. Set
 * `PATHFINDER_LLM_FALLBACKS=off` if the beta is not enabled on the account —
 * without it every call would 400 and quietly degrade to the offline path.
 */
export const USE_REFUSAL_FALLBACKS =
  (process.env.PATHFINDER_LLM_FALLBACKS ?? 'on').toLowerCase() !== 'off'

export const CORS_ORIGINS = (
  process.env.PATHFINDER_CORS_ORIGINS ??
  'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Requests per window, per IP, on the two routes that can spend money. */
export const LLM_RATE_LIMIT = intEnv('PATHFINDER_LLM_RATE_LIMIT', 30)
export const LLM_RATE_WINDOW_MS = intEnv('PATHFINDER_LLM_RATE_WINDOW_MS', 60_000)

/** Below this the model's own answer is not trusted; keywords decide instead. */
export const EXTRACTION_CONFIDENCE_FLOOR = 0.55
