/**
 * HTTP plumbing: one error shape, one validation path, one rate limiter.
 *
 * Routes throw; nothing here is allowed to leak a stack trace to a client.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType } from 'zod'

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
