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
 * unavailable, slow, rate limited, or wrong. Nothing it returns decides
 * what is in the path.
 *
 *   npm run server        start it
 *   npm run server:check  typecheck it
 *   npm run smoke         exercise every route against a running instance
 */

import { pathToFileURL } from 'node:url'
import cors from 'cors'
import express from 'express'
import {
  CORS_ORIGINS,
  HOST,
  LLM_ENABLED,
  LLM_MODE,
  LLM_RATE_LIMIT,
  LLM_RATE_WINDOW_MS,
  MODEL,
  PORT,
} from './config'
import { errorHandler, notFound, rateLimit } from './http'
import { bankMeta } from './quiz'
import { catalogRouter } from './routes/catalog'
import { chatRouter } from './routes/chat'
import { goalRouter } from './routes/goal'
import { healthRouter } from './routes/health'
import { narrateRouter } from './routes/narrate'
import { pathRouter } from './routes/path'
import { quizRouter } from './routes/quiz'
import { rootRouter } from './routes/root'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')

  app.use(cors({ origin: CORS_ORIGINS }))
  app.use(express.json({ limit: '256kb' }))

  const api = express.Router()

  // Deterministic routes. No network, no key, no budget.
  api.use(rootRouter)
  api.use(healthRouter)
  api.use(catalogRouter)
  api.use(pathRouter)
  api.use(quizRouter)

  // Routes that can spend money get a limiter first. This is not a security
  // control — it is there so a retry loop in the UI cannot drain the budget.
  const llmLimiter = rateLimit({ limit: LLM_RATE_LIMIT, windowMs: LLM_RATE_WINDOW_MS })
  api.post('/chat', llmLimiter)
  api.post('/goal/extract', llmLimiter)
  api.post('/narrate', llmLimiter)

  api.use(chatRouter)
  api.use(goalRouter)
  api.use(narrateRouter)

  app.use('/api', api)

  // The API is the whole server, so the bare origin is not a dead end.
  app.get('/', (_req, res) => res.redirect(302, '/api'))

  app.use(notFound)
  app.use(errorHandler)

  return app
}

function banner(): string {
  const lines = [
    '',
    `  Pathfinder API   http://${HOST}:${PORT}/api   <- open this, it lists every route`,
    `  Engine           deterministic (src/lib/engine.ts)`,
    `  Item bank        ${bankMeta.items} items across ${bankMeta.skills.length} skills`,
    LLM_ENABLED
      ? `  Model            ${MODEL} at two edges (mode: ${LLM_MODE})`
      : `  Model            OFF (mode: ${LLM_MODE}) — every route answers deterministically`,
    ...(LLM_ENABLED
      ? []
      : ['  To enable it    put ANTHROPIC_API_KEY=sk-ant-... in .env, then restart']),
    '',
  ]
  if (bankMeta.unreviewed.length > 0) {
    lines.splice(
      -1,
      0,
      `  WARNING          ${bankMeta.unreviewed.length} quiz items are not marked reviewed`,
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
