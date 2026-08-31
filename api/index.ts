/**
 * The Vercel entry point.
 *
 * There is no long-lived process to `listen()` here, so this file contains
 * nothing but the app: `createApp()` returns an Express instance, an Express
 * instance is already a `(req, res)` function, and that is exactly the shape
 * of a Vercel Node function. No adapter, and no second copy of the wiring —
 * this is the same app `npm run server` starts locally, which is the whole
 * reason `server/index.ts` exports `createApp` and only listens when it is
 * the entrypoint.
 *
 * Built once at module scope rather than per request. Vercel reuses a warm
 * instance across invocations, so the router tree, the config parse and the
 * quiz bank read happen once per cold start instead of once per request.
 *
 * Two properties of this environment the local server never has to think
 * about. Both are set as environment variables, not code — see the Vercel
 * section of `.env.example`:
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
 * in `http.ts` are in-process, so on Vercel they are per warm instance
 * rather than per deployment: concurrent traffic gets more than one instance
 * and each carries its own ceiling. Both modules already say this; serverless
 * is where it stops being theoretical. The fix is the shared counter
 * `budget.ts` names, and the interface does not change.
 */

import { createApp } from '../server/index'

export default createApp()
