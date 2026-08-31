/**
 * The index page for `/api`.
 *
 * It exists because the startup banner points at `/api`, and a URL you are
 * told to open should show you something. A browser gets a readable list of
 * every endpoint; curl and fetch get the same list as JSON.
 */

import { Router } from 'express'
import { LLM_MODE } from '../config'
import { llmEnabled, modelFor, resolveChain } from '../providers'

export const rootRouter = Router()

interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  summary: string
  /** True where a model may be called — each of these falls back if it is not. */
  model?: boolean
}

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/api/health', summary: 'Status, counts, and the last model error' },
  { method: 'GET', path: '/api/catalog', summary: 'Skills, resources, tags, labels' },
  { method: 'GET', path: '/api/goals', summary: 'The four goal templates' },
  { method: 'POST', path: '/api/path', summary: 'Generate a learning path for a profile' },
  { method: 'POST', path: '/api/profile/skills', summary: 'Current skill levels and gaps' },
  { method: 'GET', path: '/api/quiz', summary: 'Item bank metadata and coverage' },
  { method: 'GET', path: '/api/quiz/:skillId', summary: 'Questions for a skill, without the answers' },
  { method: 'POST', path: '/api/quiz/grade', summary: 'Grade a round, update mastery, re-plan' },
  { method: 'POST', path: '/api/auth/register', summary: 'Create an account and start a session' },
  { method: 'POST', path: '/api/auth/login', summary: 'Start a session' },
  { method: 'POST', path: '/api/auth/logout', summary: 'End this session' },
  { method: 'GET', path: '/api/auth/me', summary: 'Who is signed in — `user: null` when nobody is' },
  { method: 'DELETE', path: '/api/auth/me', summary: 'Close the account and cascade its data' },
  { method: 'GET', path: '/api/me/state', summary: 'Saved profile, progress and conversation' },
  { method: 'PUT', path: '/api/me/state', summary: 'Save the whole learner against the account' },
  { method: 'GET', path: '/api/providers', summary: 'Registered providers, which keys are present, failover order' },
  { method: 'POST', path: '/api/providers/check', summary: 'Live-check every configured key', model: true },
  { method: 'POST', path: '/api/goal/extract', summary: 'Free text to a known goal id', model: true },
  { method: 'POST', path: '/api/chat', summary: 'Assistant turn, plus the recomputed path', model: true },
  { method: 'POST', path: '/api/narrate', summary: 'Prose for an already-computed explanation', model: true },
]

const EXAMPLES = [
  'curl http://127.0.0.1:8787/api/health',
  `curl -X POST http://127.0.0.1:8787/api/path -H 'content-type: application/json' -d '{"profile":{"goalId":"ml-engineer"}}'`,
  'curl "http://127.0.0.1:8787/api/quiz/python?count=3"',
  'curl -X POST http://127.0.0.1:8787/api/providers/check',
  `curl -X POST http://127.0.0.1:8787/api/chat -H 'content-type: application/json' -d '{"text":"i want to be an ml engineer","profile":{},"provider":"openai"}'`,
]

function describeModel(): string {
  if (!llmEnabled()) {
    return `off (mode: ${LLM_MODE}) — every route answers deterministically`
  }
  const chain = resolveChain()
  return `${chain.map((id) => `${id}/${modelFor(id)}`).join(' → ')} (mode: ${LLM_MODE})`
}

// Deliberately plain, and consistent with the app's rules: structure drawn
// with 1px lines, no shadows, no gradients, one accent.
function page(nonce: string): string {
  const rows = ENDPOINTS.map((endpoint) => {
    const href =
      endpoint.method === 'GET' && !endpoint.path.includes(':')
        ? `<a href="${endpoint.path}">${endpoint.path}</a>`
        : endpoint.path
    return `<tr>
      <td class="method">${endpoint.method}</td>
      <td class="path">${href}</td>
      <td>${endpoint.summary}${endpoint.model ? ' <span class="tag">model</span>' : ''}</td>
    </tr>`
  }).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pathfinder API</title>
<style nonce="${nonce}">
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e3e5e9; --accent: #2f6feb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0e1013; --fg: #e6e8ec; --muted: #8b93a1; --line: #23262c; --accent: #6b9bff; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  p { margin: 0 0 24px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 32px; }
  th, td { text-align: left; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 500; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  td.method { color: var(--muted); width: 56px; }
  td.path { width: 240px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .tag { color: var(--accent); border: 1px solid var(--accent); border-radius: 2px; padding: 0 4px; font-size: 11px; }
  pre { margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--line); overflow-x: auto; font-size: 13px; }
  h2 { font-size: 12px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 10px; }
  footer { margin-top: 32px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Pathfinder API</h1>
  <p>Engine: deterministic (src/lib/engine.ts) &middot; Model: ${describeModel()}</p>

  <table>
    <thead><tr><th>Method</th><th>Path</th><th>What it does</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <h2>Try it</h2>
${EXAMPLES.map((example) => `  <pre>${example.replace(/</g, '&lt;')}</pre>`).join('\n')}

  <footer>
    Routes marked <span class="tag">model</span> may call a language model and
    fall back to a deterministic answer if it is unavailable. Full reference:
    <code>server/README.md</code>.
  </footer>
</main>
</body>
</html>`
}

rootRouter.get('/', (_req, res) => {
  const body = {
    name: 'Pathfinder API',
    engine: 'deterministic (src/lib/engine.ts)',
    model: describeModel(),
    endpoints: ENDPOINTS,
    docs: 'server/README.md',
  }
  const nonce = String(res.locals.cspNonce ?? '')

  // A browser asks for text/html at q=1.0 and gets the page. curl and fetch
  // send `*/*`, which matches everything equally — and `res.format` breaks
  // that tie on key order, so `json` has to come first or an API client would
  // be handed HTML.
  res.format({
    json: () => res.json(body),
    html: () => res.type('html').send(page(nonce)),
    default: () => res.json(body),
  })
})
