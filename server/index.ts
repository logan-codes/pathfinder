/**
 * Pathfinder API.
 *
 * A thin HTTP surface over the same domain layer the UI already uses
 * (`src/lib/*`), so there is one engine, one catalogue and one set of types
 * rather than a server copy that drifts.
 *
 * Deterministic by default. A model is consulted for three things, all of
 * them language: reading a free-text goal (/api/goal/extract, /api/chat),
 * wording an explanation (/api/narrate), and wording an assistant reply
 * (/api/chat). Each degrades to a deterministic answer if the model is
 * unavailable, slow, rate limited, over budget, refused, or wrong. Nothing
 * it returns decides what is in the path.
 *
 * The model behind those three edges is whichever provider has a key —
 * see `server/providers.ts`. `/api/providers` lists them, and
 * `POST /api/providers/check` proves each key works.
 *
 *   npm run server        start it
 *   npm run server:check  typecheck it
 *   npm run smoke         exercise every route against a running instance
 */

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import {
  ALLOW_REGISTRATION,
  API_KEY,
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW_MS,
  CORS_ORIGINS,
  HOST,
  INJECTION_POLICY,
  LLM_MODE,
  LLM_RATE_LIMIT,
  LLM_RATE_WINDOW_MS,
  PORT,
  SUPABASE_URL,
  TRUST_PROXY,
} from './config.js'
import { budgetReport } from './budget.js'
import { attachSession, errorHandler, notFound, rateLimit, requireApiKey } from './http.js'
import { llmEnabled, modelFor, resolveChain } from './providers.js'
import { bankMeta } from './quiz.js'
import { supabaseAdminEnabled, supabaseEnabled } from './supabase.js'
import { authRouter } from './routes/auth.js'
import { catalogRouter } from './routes/catalog.js'
import { chatRouter } from './routes/chat.js'
import { goalRouter } from './routes/goal.js'
import { healthRouter } from './routes/health.js'
import { narrateRouter } from './routes/narrate.js'
import { pathRouter } from './routes/path.js'
import { providersRouter } from './routes/providers.js'
import { quizRouter } from './routes/quiz.js'
import { rootRouter } from './routes/root.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')

  // Off unless something in front of the server really is setting
  // X-Forwarded-For. Trusting it blindly turns the per-IP limiter into a
  // header anyone can rewrite.
  app.set('trust proxy', TRUST_PROXY ? 1 : false)

  // The index page carries an inline stylesheet, so it gets a per-request
  // nonce rather than a blanket 'unsafe-inline' for the whole API.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomUUID()
    next()
  })

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'self'", (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`],
          scriptSrc: ["'none'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // The API is JSON over a local origin; HSTS on localhost only creates
      // a browser pin nobody asked for.
      strictTransportSecurity: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  )

  // `credentials` so the browser will send the session cookie. With an
  // explicit origin allowlist this stays a closed door rather than an open
  // one — `*` and credentials are mutually exclusive for good reason.
  app.use(cors({ origin: CORS_ORIGINS, credentials: true }))
  app.use(express.json({ limit: '256kb' }))

  const api = express.Router()

  // Resolves a session onto the request when one is present, and does
  // nothing when it is not. Signed out is a normal state here.
  api.use(attachSession)

  // Open even when a key is configured: the index page carries no data, and
  // liveness is how you diagnose a server you cannot authenticate to. The
  // health route trims itself to `ok` for an unauthenticated caller.
  api.use(rootRouter)
  api.use(healthRouter)

  // Sign-in has to be reachable before you have a credential, so it sits
  // ahead of the deployment door — with a much tighter limiter, since this
  // is the one route where guessing is the whole attack.
  const authLimiter = rateLimit({ limit: AUTH_RATE_LIMIT, windowMs: AUTH_RATE_WINDOW_MS })
  api.post('/auth/login', authLimiter)
  api.post('/auth/register', authLimiter)
  api.post('/auth/password', authLimiter)
  api.use(authRouter)

  // Everything past this line needs the key, when one is set. A signed-in
  // user counts as a credential, so people use sessions and machines use
  // the key.
  api.use(requireApiKey())

  // Deterministic routes. No network, no key, no budget.
  api.use(catalogRouter)
  api.use(pathRouter)
  api.use(quizRouter)

  // Routes that can spend money get a limiter first. Per-IP and in-memory,
  // so it bounds one client; the process-wide cap in `budget.ts` is what
  // bounds the bill.
  const llmLimiter = rateLimit({ limit: LLM_RATE_LIMIT, windowMs: LLM_RATE_WINDOW_MS })
  api.post('/chat', llmLimiter)
  api.post('/goal/extract', llmLimiter)
  api.post('/narrate', llmLimiter)
  api.post('/providers/check', llmLimiter)

  api.use(chatRouter)
  api.use(goalRouter)
  api.use(narrateRouter)
  api.use(providersRouter)

  app.use('/api', api)

  // The API is the whole server, so the bare origin is not a dead end.
  app.get('/', (_req, res) => res.redirect(302, '/api'))

  app.use(notFound)
  app.use(errorHandler)

  return app
}

function banner(): string {
  const chain = resolveChain()
  const budget = budgetReport()

  const lines = [
    '',
    `  Pathfinder API   http://${HOST}:${PORT}/api   <- open this, it lists every route`,
    `  Engine           deterministic (src/lib/engine.ts)`,
    `  Item bank        ${bankMeta.items} items across ${bankMeta.skills.length} skills`,
    llmEnabled()
      ? `  Providers        ${chain.map((id) => `${id} (${modelFor(id)})`).join(' -> ')}`
      : `  Providers        none configured (mode: ${LLM_MODE}) — every route answers deterministically`,
    `  Guardrails       injection: ${INJECTION_POLICY} - rate limit: ${LLM_RATE_LIMIT}/window - api key: ${API_KEY ? 'on' : 'off'}`,
    `  Budget           ${budget.limits.calls ?? '∞'} calls, ${budget.limits.tokens ?? '∞'} tokens, $${budget.limits.usd ?? '∞'}`,
    supabaseEnabled()
      ? `  Accounts         Supabase ${new URL(SUPABASE_URL!).host} - sign-up ${ALLOW_REGISTRATION ? 'open' : 'closed'}${supabaseAdminEnabled() ? '' : ' - no service key, account deletion off'}`
      : `  Accounts         off (no SUPABASE_URL) — sign-in hidden, everything else works`,
    '',
  ]

  if (!llmEnabled()) {
    lines.splice(-1, 0, '  To enable it     put a key in .env (any provider), then restart')
  }
  if (bankMeta.unreviewed.length > 0) {
    lines.splice(
      -1,
      0,
      `  WARNING          ${bankMeta.unreviewed.length} quiz items are not marked reviewed`,
    )
  }
  if (!API_KEY && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    lines.splice(
      -1,
      0,
      `  WARNING          bound to ${HOST} with no PATHFINDER_API_KEY — anyone who can reach it can spend your keys`,
    )
  }

  return lines.join('\n')
}

// Only listen when run directly, so a test can import `createApp` instead.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const server = createApp().listen(PORT, HOST)

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${PORT} is already in use. Set PORT to something else, e.g. PORT=8788 npm run server\n`,
      )
      process.exit(1)
    }
    throw error
  })

  server.on('listening', () => {
    // Deliberately not printed straight from the listen callback. On Windows
    // a losing race for the port can emit 'listening' and only then fail with
    // EADDRINUSE, which printed a banner advertising a URL that served
    // nothing. Letting the error handler exit first is the whole point of the
    // delay; `server.listening` is already false by then in any case.
    setTimeout(() => {
      if (server.listening) console.log(banner())
    }, 50).unref()
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
