/**
 * HTTP plumbing: one error shape, one validation path, one rate limiter.
 *
 * Routes throw; nothing here is allowed to leak a stack trace to a client.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType } from 'zod'
import { API_KEY, COOKIE_SECURE, SESSION_TTL_MS } from './config.js'
import { refreshSession, resolveAccessToken, supabaseEnabled, type Caller } from './supabase.js'

/** The signed-in learner, when there is one. Set by `attachSession`. */
declare module 'express-serve-static-core' {
  interface Request {
    user?: Caller
  }
}

/**
 * Two cookies rather than one. Supabase issues a short-lived access token
 * (an hour by default) and a long-lived refresh token; keeping them separate
 * means the access token can be replaced without touching the thing that
 * authorises replacing it.
 *
 * Both are httpOnly, so no script on the page can read either — which is the
 * point of not putting them in localStorage the way the Supabase browser SDK
 * does by default.
 */
export const ACCESS_COOKIE = 'pf_at'
export const REFRESH_COOKIE = 'pf_rt'

export interface ErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export class HttpError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Express 5 forwards rejected promises on its own, but only for handlers it
 * recognises as async. Wrapping is one line and removes the question.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next)
  }
}

/** Validate a request body, turning a Zod failure into a 400 with detail. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  return parseInput(schema, body, 'Request body')
}

/** Same, for query strings. `QuizQuery` coerces the strings to numbers. */
export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  return parseInput(schema, query, 'Query string')
}

function parseInput<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data

  throw new HttpError(
    400,
    'invalid_request',
    `${what} failed validation.`,
    result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  )
}

/**
 * Fixed-window limiter, in memory, per IP. Not a security control — it is
 * there so a runaway retry loop in the UI cannot empty the API budget.
 */
export function rateLimit(options: { limit: number; windowMs: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>()

  return (req, res, next) => {
    const now = Date.now()
    const key = req.ip ?? 'unknown'
    const entry = hits.get(key)

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs })
    } else if (entry.count >= options.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      next(
        new HttpError(429, 'rate_limited', `Too many requests. Retry in ${retryAfter}s.`),
      )
      return
    } else {
      entry.count += 1
    }

    // Opportunistic sweep so the map cannot grow without bound.
    if (hits.size > 1000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
    }

    next()
  }
}

// ---- credentials --------------------------------------------------------

/**
 * Express does not parse cookies without middleware, and the one header we
 * care about is worth five lines more than it is worth a dependency.
 */
function cookie(req: Request, name: string): string | null {
  const header = req.get('cookie')
  if (!header) return null

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/** A bearer credential, from either the header or the access cookie. */
function presentedToken(req: Request): string | null {
  const header = req.get('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null
  const apiKeyHeader = req.get('x-api-key')?.trim()
  if (apiKeyHeader) return apiKeyHeader
  return cookie(req, ACCESS_COOKIE)
}

function matchesApiKey(presented: string): boolean {
  if (!API_KEY) return false
  const expected = createHash('sha256').update(API_KEY).digest()
  const actual = createHash('sha256').update(presented).digest()
  return timingSafeEqual(expected, actual)
}

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'lax',
  secure: COOKIE_SECURE,
  path: '/',
} as const

export function setSessionCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
): void {
  // The access cookie is given the refresh cookie's lifetime rather than the
  // token's. An expired token in a live cookie is exactly the case the
  // refresh path handles; a missing cookie is not, and would look to the
  // browser like being signed out an hour after signing in.
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...COOKIE_BASE, maxAge: SESSION_TTL_MS })
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...COOKIE_BASE, maxAge: SESSION_TTL_MS })
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' })
  res.clearCookie(REFRESH_COOKIE, { path: '/' })
}

/**
 * Resolves a Supabase session onto the request when one is present, silently
 * refreshing an expired access token on the way through.
 *
 * Never rejects. Signed out is a normal state in this app — routes that need
 * a person say so with `requireUser`, and most routes here do not.
 */
export const attachSession: RequestHandler = async (req, res, next) => {
  if (!supabaseEnabled()) return next()

  const accessToken = cookie(req, ACCESS_COOKIE) ?? bearerOf(req)
  if (accessToken) {
    const caller = await resolveAccessToken(accessToken)
    if (caller) {
      req.user = caller
      return next()
    }
  }

  // No usable access token. If there is a refresh token, spend it — this is
  // the ordinary path an hour after signing in, not an error.
  const refreshToken = cookie(req, REFRESH_COOKIE)
  if (!refreshToken) return next()

  const refreshed = await refreshSession(refreshToken)
  if (!refreshed) {
    // The refresh token is dead too. Clear both, so the browser stops
    // presenting credentials that will never work again.
    clearSessionCookies(res)
    return next()
  }

  setSessionCookies(res, refreshed)
  req.user = refreshed.caller
  next()
}

/** Only the Authorization header, for callers with no cookie jar. */
function bearerOf(req: Request): string | null {
  const header = req.get('authorization')
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null
}

/**
 * The deployment door, on when PATHFINDER_API_KEY is set.
 *
 * Two things open it: the shared key (for machines) or a valid user session
 * (for people). Without that second case a browser could never reach the
 * login route to get a session in the first place.
 *
 * Comparison runs over digests, so it is constant-time and length-independent.
 */
export function requireApiKey(): RequestHandler {
  if (!API_KEY) return (_req, _res, next) => next()

  return (req, _res, next) => {
    if (req.user) return next()

    const presented = presentedToken(req)
    if (!presented) {
      next(new HttpError(401, 'unauthorized', 'Missing API key. Send Authorization: Bearer <key>.'))
      return
    }

    if (!matchesApiKey(presented)) {
      next(new HttpError(403, 'forbidden', 'That API key is not valid.'))
      return
    }

    next()
  }
}

/** For routes that need a person rather than a machine. */
export const requireUser: RequestHandler = (req, _res, next) => {
  if (req.user) return next()
  next(new HttpError(401, 'not_signed_in', 'Sign in to use this route.'))
}

/** Whether a request carried any accepted credential. */
export function isAuthenticated(req: Request): boolean {
  if (!API_KEY) return true
  if (req.user) return true
  const presented = presentedToken(req)
  return presented !== null && matchesApiKey(presented)
}

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`))
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } }
    if (err.details !== undefined) body.error.details = err.details
    res.status(err.status).json(body)
    return
  }

  // express.json() rejects a malformed body with a tagged SyntaxError.
  // Without this it would be reported as a server fault, which it is not.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { code: 'invalid_json', message: 'Request body is not valid JSON.' },
    } satisfies ErrorBody)
    return
  }

  // Anything unexpected is ours, not the caller's. Log it, say little.
  console.error('[pathfinder] unhandled error:', err)
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong on the server.' },
  } satisfies ErrorBody)
}
