/**
 * The Vercel entry point.
 *
 * There is no long-lived process to `listen()` here, so this file is nothing
 * but the app: `createApp()` returns an Express instance, an Express instance
 * is already a `(req, res)` function, and that is exactly the shape of a
 * Vercel Node function. No adapter, and no second copy of the wiring — this
 * is the same app `npm run server` starts locally, which is why
 * `server/index.ts` exports `createApp` and only listens when run directly.
 *
 * Note the `.js` on the import, and on every relative import under `server/`
 * and `src/lib/`. Vercel compiles TypeScript per file and copies specifiers
 * through verbatim, so what Node's ESM loader receives is what was written.
 * Node requires an explicit extension on a relative specifier; `tsx`, Vite
 * and `tsc` are all willing to guess one, which is why an extensionless
 * import works in every local runner and fails only once deployed. The `.js`
 * names the compiled output and TypeScript maps it back to the `.ts` source,
 * so one spelling satisfies both.
 *
 * Built once at module scope rather than per request. Vercel reuses a warm
 * instance across invocations, so the router tree and the config parse cost
 * one cold start rather than one request.
 *
 * Two properties of this environment the local server never has to think
 * about, both set as environment variables — see `.env.example`:
 *
 *   NODEJS_HELPERS=0          Vercel otherwise wraps req/res with its own
 *                             body parsing, which races `express.json()` for
 *                             the request stream. Off, Express receives the
 *                             raw Node objects it expects.
 *   PATHFINDER_TRUST_PROXY=on Every request arrives via Vercel's edge, so
 *                             without this `req.ip` is one shared value and
 *                             the per-IP limiter silently becomes a global
 *                             one. Here the forwarded header really is set
 *                             by the proxy, which is the condition
 *                             `config.ts` asks for before trusting it.
 *
 * One honest limitation. The budget counters in `budget.ts` and the limiter
 * in `http.ts` are in-process, so here they are per warm instance rather
 * than per deployment: concurrent traffic gets more than one instance and
 * each carries its own ceiling. Both modules already say so; serverless is
 * where it stops being theoretical. The fix is the shared counter
 * `budget.ts` names, and the interface does not change.
 */

import { createApp } from '../server/index.js'

export default createApp()
