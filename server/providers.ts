/**
 * The provider registry.
 *
 * Every model call in this server goes through LangChain's `BaseChatModel`,
 * so the vendor behind a call is a configuration detail rather than a code
 * path. Drop a key in the environment and that provider becomes selectable;
 * drop five and the same three endpoints can be evaluated across all five
 * without touching a line of application code.
 *
 * Why LangChain and not LangGraph: the orchestration here is already
 * deterministic and lives in `src/lib/engine.ts`. There is no cyclic,
 * model-driven control flow to schedule, no checkpointing, no human-in-the-
 * loop interrupt — the model calls are single-shot leaves at three edges.
 * LangGraph would add a graph runtime we would never step through. What we
 * actually needed was one uniform chat-model interface with portable
 * structured output, which is plain LangChain.
 *
 * Packages are loaded with a dynamic import and cached. A provider whose
 * package is missing reports itself unavailable rather than taking the
 * server down, so a slimmed-down install still boots.
 */

import { createHash } from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  ALLOW_PROVIDER_OVERRIDE,
  LLM_MODE,
  LLM_TIMEOUT_MS,
  PROVIDER_FALLBACK,
  PROVIDER_ORDER,
  PRICE_OVERRIDES,
  providerModelOverride,
} from './config'

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'groq' | 'mistral'

export interface CreateOptions {
  model: string
  apiKey: string
  maxTokens: number
  temperature: number
  /** LangChain retries inside one call; keep it low, the timeout is outside. */
  maxRetries: number
}

export interface ProviderSpec {
  id: ProviderId
  label: string
  /** Any one of these present in the environment counts as configured. */
  envKeys: string[]
  packageName: string
  /** Env var that overrides the model for this provider specifically. */
  modelEnv: string
  defaultModel: string
  /**
   * USD per million tokens. Rough list prices, used only for the local spend
   * ceiling in `budget.ts` — never for billing, and certainly never shown as
   * an invoice. Override with PATHFINDER_PRICE_<PROVIDER>="input,output".
   */
  pricing: { input: number; output: number }
  create: (options: CreateOptions) => Promise<BaseChatModel>
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    packageName: '@langchain/anthropic',
    modelEnv: 'PATHFINDER_MODEL_ANTHROPIC',
    defaultModel: 'claude-opus-5',
    pricing: { input: 5, output: 25 },
    create: async (options) => {
      const { ChatAnthropic } = await import('@langchain/anthropic')
      return new ChatAnthropic({
        model: options.model,
        apiKey: options.apiKey,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        maxRetries: options.maxRetries,
      })
    },
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    envKeys: ['OPENAI_API_KEY'],
    packageName: '@langchain/openai',
    modelEnv: 'PATHFINDER_MODEL_OPENAI',
    defaultModel: 'gpt-4.1-mini',
    pricing: { input: 0.4, output: 1.6 },
    create: async (options) => {
      const { ChatOpenAI } = await import('@langchain/openai')
      return new ChatOpenAI({
        model: options.model,
        apiKey: options.apiKey,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        maxRetries: options.maxRetries,
      })
    },
  },

  google: {
    id: 'google',
    label: 'Google Gemini',
    envKeys: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    packageName: '@langchain/google-genai',
    modelEnv: 'PATHFINDER_MODEL_GOOGLE',
    defaultModel: 'gemini-2.0-flash',
    pricing: { input: 0.1, output: 0.4 },
    create: async (options) => {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai')
      return new ChatGoogleGenerativeAI({
        model: options.model,
        apiKey: options.apiKey,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        maxRetries: options.maxRetries,
      })
    },
  },

  groq: {
    id: 'groq',
    label: 'Groq',
    envKeys: ['GROQ_API_KEY'],
    packageName: '@langchain/groq',
    modelEnv: 'PATHFINDER_MODEL_GROQ',
    // Groq retires hosted models fairly aggressively — `llama-3.3-70b-versatile`
    // was the default here until it started 404ing. Whatever sits here must
    // support tool calling, because `withStructuredOutput` uses it for goal
    // extraction; `GET https://api.groq.com/openai/v1/models` lists what an
    // account can currently reach.
    defaultModel: 'openai/gpt-oss-120b',
    pricing: { input: 0.15, output: 0.75 },
    create: async (options) => {
      const { ChatGroq } = await import('@langchain/groq')
      return new ChatGroq({
        model: options.model,
        apiKey: options.apiKey,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        maxRetries: options.maxRetries,
      })
    },
  },

  mistral: {
    id: 'mistral',
    label: 'Mistral',
    envKeys: ['MISTRAL_API_KEY'],
    packageName: '@langchain/mistralai',
    modelEnv: 'PATHFINDER_MODEL_MISTRAL',
    defaultModel: 'mistral-large-latest',
    pricing: { input: 2, output: 6 },
    create: async (options) => {
      const { ChatMistralAI } = await import('@langchain/mistralai')
      return new ChatMistralAI({
        model: options.model,
        apiKey: options.apiKey,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        maxRetries: options.maxRetries,
      })
    },
  },
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value)
}

// ---- credentials --------------------------------------------------------

interface Credential {
  env: string
  value: string
}

function credentialFor(spec: ProviderSpec): Credential | null {
  for (const env of spec.envKeys) {
    const value = process.env[env]
    if (value && value.trim()) return { env, value: value.trim() }
  }
  return null
}

/**
 * Eight hex characters of a SHA-256 over the key. Enough for a judge to
 * confirm which key is loaded and that two deployments match, and useless to
 * anyone who wants the key itself. The value is never logged or returned.
 */
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export function modelFor(id: ProviderId): string {
  return providerModelOverride(PROVIDERS[id].modelEnv) ?? PROVIDERS[id].defaultModel
}

export function pricingFor(id: ProviderId): { input: number; output: number } {
  return PRICE_OVERRIDES[id] ?? PROVIDERS[id].pricing
}

/** USD for one call. Estimated, and only ever used against the local cap. */
export function estimateCost(
  id: ProviderId,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = pricingFor(id)
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output
}

export function isConfigured(id: ProviderId): boolean {
  return credentialFor(PROVIDERS[id]) !== null
}

export function configuredProviders(): ProviderId[] {
  return PROVIDER_IDS.filter(isConfigured)
}

// ---- instantiation ------------------------------------------------------

const cache = new Map<string, BaseChatModel>()
/** Packages that failed to import, so we do not retry the import per call. */
const unavailable = new Map<ProviderId, string>()

export class ProviderUnavailableError extends Error {
  readonly provider: ProviderId

  constructor(provider: ProviderId, reason: string) {
    super(`${provider} is unavailable: ${reason}`)
    this.name = 'ProviderUnavailableError'
    this.provider = provider
  }
}

export interface ModelHandle {
  provider: ProviderId
  model: string
  chat: BaseChatModel
}

export async function getModel(
  id: ProviderId,
  options: { maxTokens: number; temperature?: number; maxRetries?: number },
): Promise<ModelHandle> {
  const spec = PROVIDERS[id]
  const credential = credentialFor(spec)
  if (!credential) throw new ProviderUnavailableError(id, `no key in ${spec.envKeys.join(' or ')}`)

  const known = unavailable.get(id)
  if (known) throw new ProviderUnavailableError(id, known)

  const model = modelFor(id)
  const temperature = options.temperature ?? 0.2
  const maxRetries = options.maxRetries ?? 0
  const key = `${id}:${model}:${options.maxTokens}:${temperature}:${maxRetries}:${fingerprint(credential.value)}`

  const cached = cache.get(key)
  if (cached) return { provider: id, model, chat: cached }

  try {
    const chat = await spec.create({
      model,
      apiKey: credential.value,
      maxTokens: options.maxTokens,
      temperature,
      maxRetries,
    })
    cache.set(key, chat)
    return { provider: id, model, chat }
  } catch (error) {
    // A missing package is permanent for this process; a bad key is not, so
    // only the import failure is remembered.
    const reason = error instanceof Error ? error.message : String(error)
    if (/cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(reason)) {
      unavailable.set(id, `package ${spec.packageName} is not installed`)
    }
    throw new ProviderUnavailableError(id, reason)
  }
}

// ---- reporting ----------------------------------------------------------

export interface ProviderStatus {
  id: ProviderId
  label: string
  /** A key is present in the environment. */
  configured: boolean
  /** Which env var supplied it. Never the value. */
  keySource: string | null
  /** Salted-free SHA-256 prefix, so two deployments can be compared safely. */
  keyFingerprint: string | null
  model: string
  packageName: string
  /** Set when the package failed to load earlier in this process. */
  unavailableReason: string | null
  pricingPerMTok: { input: number; output: number }
  envKeys: string[]
}

export function providerStatus(id: ProviderId): ProviderStatus {
  const spec = PROVIDERS[id]
  const credential = credentialFor(spec)

  return {
    id,
    label: spec.label,
    configured: credential !== null,
    keySource: credential?.env ?? null,
    keyFingerprint: credential ? fingerprint(credential.value) : null,
    model: modelFor(id),
    packageName: spec.packageName,
    unavailableReason: unavailable.get(id) ?? null,
    pricingPerMTok: pricingFor(id),
    envKeys: spec.envKeys,
  }
}

export function providerStatuses(): ProviderStatus[] {
  return PROVIDER_IDS.map(providerStatus)
}

// ---- selection ----------------------------------------------------------

/**
 * `on` and `auto` behave identically now. Under the old Anthropic SDK, `on`
 * meant "try anyway, the SDK may find an `ant auth login` profile we cannot
 * see from here". LangChain is handed an explicit key, so a provider without
 * one cannot be called into existence and the distinction is gone. The knob
 * is kept because `off` still guarantees a fully offline server.
 */
export function llmEnabled(): boolean {
  return LLM_MODE !== 'off' && configuredProviders().length > 0
}

/**
 * The providers to try for one call, in order. A caller may name the first
 * one; the rest of the chain follows only when failover is on.
 */
export function resolveChain(requested?: string | null): ProviderId[] {
  const available = new Set(configuredProviders())
  if (LLM_MODE === 'off' || available.size === 0) return []

  const ordered = PROVIDER_ORDER.filter(
    (id): id is ProviderId => isProviderId(id) && available.has(id),
  )
  // A provider with a key that nobody listed still beats no model at all.
  for (const id of configuredProviders()) if (!ordered.includes(id)) ordered.push(id)

  if (requested && ALLOW_PROVIDER_OVERRIDE && isProviderId(requested) && available.has(requested)) {
    const rest = PROVIDER_FALLBACK ? ordered.filter((id) => id !== requested) : []
    return [requested, ...rest]
  }

  return PROVIDER_FALLBACK ? ordered : ordered.slice(0, 1)
}

// ---- liveness -----------------------------------------------------------

export interface ProviderCheck {
  id: ProviderId
  model: string
  ok: boolean
  latencyMs: number
  /** Present only on failure. Never contains the key. */
  error: string | null
}

/**
 * One real, minimal call. This is what makes "every key works" a measured
 * claim rather than a configuration screenshot — the endpoint that uses it
 * is rate limited and counted against the same budget as everything else.
 */
export async function checkProvider(id: ProviderId): Promise<ProviderCheck> {
  const startedAt = Date.now()
  const model = modelFor(id)

  try {
    // Generous for a one-word answer, because reasoning models spend their
    // budget thinking before they emit any visible text. At 16 tokens a
    // model like gpt-oss returns a perfectly healthy response with empty
    // content, which read as a dead key rather than a tight ceiling.
    const handle = await getModel(id, { maxTokens: 512, temperature: 0 })
    const reply = await handle.chat.invoke([new HumanMessage('Reply with the word: ready')], {
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })

    // What this checks is whether the credential is accepted and the provider
    // answers — not what it says. A reply carrying reasoning, tool calls or
    // token usage but no prose is still a working key.
    const text = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
    const answered =
      Boolean(text.trim()) ||
      Boolean(reply.usage_metadata?.output_tokens) ||
      Boolean(reply.additional_kwargs && Object.keys(reply.additional_kwargs).length > 0)

    if (!answered) throw new Error('provider returned nothing at all')

    return { id, model, ok: true, latencyMs: Date.now() - startedAt, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      id,
      model,
      ok: false,
      latencyMs: Date.now() - startedAt,
      // Some SDKs put the key in the request URL on error. Never echo one.
      error: redactSecrets(message).slice(0, 300),
    }
  }
}

const SECRET_SHAPED = /\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{8,}|key=[A-Za-z0-9_-]{8,})/g

function redactSecrets(message: string): string {
  return message.replace(SECRET_SHAPED, '[redacted]')
}
