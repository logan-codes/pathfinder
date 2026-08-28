# Requirements

## 1. Install this manually (one thing)

**Node.js 22 LTS** (ships with npm) — https://nodejs.org/en/download
Minimum: Node >= 20.19. Verify:

    node -v
    npm -v

That is the only manual install. Everything else comes from `package.json`.

## 2. Then run this in the project root

    npm install

## 3. Start the dev server

    npm run dev

## 4. Start the API (optional)

In a second terminal:

    npm run server

The UI works without it. Running it gives you the HTTP API described in
`server/README.md`; the dev server proxies `/api` across. No API key is
needed — without one the backend runs fully offline and every route still
answers.

---

## What `npm install` pulls in

### Runtime dependencies
| Package | Version | Why |
|---|---|---|
| `react` | ^19.0.0 | UI runtime |
| `react-dom` | ^19.0.0 | DOM renderer |
| `react-router-dom` | ^7.0.0 | Routing between Chat / Path / Dashboard / Profile |
| `zustand` | ^5.0.0 | State store (~1KB). Learner profile, generated path, progress. Swappable for React Query when a real backend lands. |
| `lucide-react` | ^0.400.0 | Line icons. Uniform stroke weight, no fills, no shine. |
| `express` | ^5.2.0 | The API in `server/`. Small, boring, well understood. |
| `cors` | ^2.8.5 | Lets the dev UI call the API directly if you bypass the proxy. |
| `zod` | ^4.4.0 | Validates request bodies, and defines the model's output schema. |
| `@anthropic-ai/sdk` | ^0.121.0 | The two model calls. Never on the critical path — both fall back. |

### Dev dependencies
| Package | Version | Why |
|---|---|---|
| `vite` | ^6.0.0 | Dev server + build |
| `@vitejs/plugin-react` | ^4.3.0 | JSX + fast refresh |
| `typescript` | ^5.6.0 | Types |
| `@types/react`, `@types/react-dom` | ^19.0.0 | React types |
| `tsx` | ^4.23.0 | Runs the TypeScript server directly, so there is no build step or emit config to keep in step with the frontend's |
| `@types/express`, `@types/cors` | latest | Server types |

### Deliberately NOT used
- **Tailwind / Bootstrap / MUI / shadcn** — opinionated visual styling I'd have to override. Plain CSS + design tokens is less code and easier for you to modify.
- **Recharts / Chart.js** — dashboard charts are hand-rolled flat SVG. Fewer deps, exact control, no default gradients.
- **Any CSS-in-JS** — theming is done with CSS custom properties on `:root` / `[data-theme]`.

### Deliberately NOT used on the backend either
- **Python / FastAPI** — an earlier draft planned this. It was dropped: the stack is TypeScript throughout, and a second language would have meant a second copy of the engine, the catalogue and the types to keep in step. `server/` imports `src/lib/` directly instead.
- **A vector DB** — the catalogue is 35 items and four goal templates. Retrieval over that is a `filter()`.
- **A database** — the API is stateless; the client sends the profile and gets the recomputed result back. Persistence is a real gap, not a claim (see `server/README.md`).
- **A test runner** — `npm run smoke` hits every route against a running server and checks the shapes the UI depends on. A unit-test framework is the right next step, not a substitute for that.

## Offline / restricted network
If npm registry access is blocked, tell me and I'll fall back to a zero-build version (plain HTML/CSS/JS, opens straight in a browser, no install at all). It works, it's just less pleasant to extend.
