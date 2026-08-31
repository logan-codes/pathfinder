/**
 * The Vercel entry point.
 *
 * There is no long-lived process to `listen()` on Vercel, so this file is
 * nothing but the app: `createApp()` returns an Express instance, an Express
 * instance is already a `(req, res)` function, and that is exactly the shape
 * of a Vercel Node function. No adapter, and no second copy of the wiring —
 * this is the same app `npm run server` starts locally, which is why
 * `server/index.ts` exports `createApp` and only listens when it is run
 * directly.
 *
 * It lives in `server/` rather than `api/` because it is source, not the
 * artifact. `npm run build:api` bundles it to `api/index.js`, and that
 * bundle is what Vercel deploys.
 *
 * Why bundle at all, when Vercel compiles TypeScript itself: it compiles
 * per file and copies import specifiers through verbatim. This codebase is
 * ESM (`"type": "module"`) and writes its relative imports without an
 * extension — `./config`, `../src/lib/catalog` — which every local runner
 * resolves and which Node's own ESM loader, correctly, does not. The
 * deployed function therefore died at its first import with
 * ERR_MODULE_NOT_FOUND. Bundling settles it once: esbuild inlines every
 * relative import, so at runtime there is one file and nothing left to
 * resolve. Packages stay external and are traced and installed as usual.
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

import { createApp } from './index'

export default createApp()
