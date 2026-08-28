# Pathfinder — AI-Powered Personalized Learning Path Recommender

UI prototype. Every screen is driven by a real, deterministic recommendation
engine — no hardcoded screenshots, no lorem ipsum. Change the profile and the
roadmap, dashboard and explanations all move together.

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173. The UI runs entirely in the browser, so this
is enough to see everything.

Run the API alongside it, in a second terminal:

```bash
npm run server    # http://127.0.0.1:8787/api
```

### Turning the model on

Optional — everything works without it. To have the assistant answer in prose
rather than templates, and to understand goal phrasings the keyword list
misses:

```bash
cp .env.example .env
```

Then put your key in `.env` at the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Restart `npm run server`. Its banner tells you which mode it is in, and the
badge in the app header changes from `API` to `API + model`. Without a key the
banner prints the same instruction.

The dev server proxies `/api` to it. The UI uses it when it is there and falls
back to running the engine in the browser when it is not — the badge in the
header says which. No API key is needed either way; without one the backend
runs deterministically and every route still answers. See
[`server/README.md`](server/README.md).

```bash
npm run build     # typecheck + production build of the UI
npm run preview   # serve the build
npm run check     # typecheck both the UI and the server
npm run smoke     # exercise every API route against a running server
```

## What is implemented

| Requirement | Where |
|---|---|
| Conversational goal capture | `src/routes/Chat.tsx` + `src/lib/assistant.ts` |
| Learner profiling engine | `src/routes/Profile.tsx` + `profileSkills()` in `src/lib/engine.ts` |
| Recommendation engine | `selectItems()` in `src/lib/engine.ts` |
| Path generator (prereqs + milestones) | `orderItems()` / `buildPath()` in `src/lib/engine.ts` |
| Explanations ("why this?") | `explain()` in `src/lib/engine.ts`, rendered in the Path rail |
| Progress dashboard | `src/routes/Dashboard.tsx` |
| Skill assessment + adaptation | `src/routes/Assess.tsx` + `server/mastery.ts` |
| HTTP API over the same engine | `server/` — see [`server/README.md`](server/README.md) |
| Goal extraction from free text | `extractGoal()` in `server/llm.ts`, falling back to `matchGoal()` |
| Model-written explanations | `narrate()` in `server/llm.ts`, falling back to the templates |
| Assessment + mastery model | `data/quiz-bank.json`, `server/quiz.ts`, `server/mastery.ts` |

## How the engine works

Five stages, all in `src/lib/engine.ts`:

1. **`profileSkills`** — derives current skill levels (0–5) from completed
   resources, self-ratings and declared experience. History beats self-rating
   when it implies more.
2. **`skillGaps`** — diffs that against the goal's target profile, weighted by
   how central each skill is to the goal.
3. **`selectItems`** — greedy selection. Each round picks the resource with the
   best marginal value against the gaps still open, adjusted for difficulty fit
   and interest match, then updates the running skill state.
4. **`orderItems`** — emits resources only once the running state satisfies
   their declared entry requirements, so prerequisites always land first.
   Terminates even on unsatisfiable requirements.
5. **`buildPath`** — chunks into milestones and attaches explanations.

Explanations are generated from the same numbers that drove selection, so the
"why this?" panel cannot drift from the actual decision.

## Structure

```
src/
  lib/          domain layer — no React imports anywhere in here
    types.ts      the contract between UI and engine
    catalog.ts    mock course/project/assessment inventory + skill taxonomy
    goals.ts      goal templates (target skill profiles) + intent matching
    engine.ts     profiling, gap analysis, selection, ordering, explanations
    assistant.ts  conversational intent handling
    format.ts     presentation helpers
  store/
    useAppStore.ts  single zustand store; actions are the only way state changes
    selectors.ts    memoised derived state (see the warning in that file)
  components/   presentational primitives — props in, markup out
  routes/       one file per screen
  styles/
    tokens.css      every colour in the app; edit this to retheme
    base.css        reset + element defaults
    layout.css      app shell and grids
    components.css  reusable components
    features.css    chat, roadmap spine, charts
  lib/api.ts      typed client for the API; nothing imports it yet

server/         the API. Imports src/lib/ — no second copy of the engine
data/           committed assessment item bank
scripts/        offline quiz authoring, end-to-end smoke test
```

## Design rules

Structure is expressed with 1px lines. There are no shadows, no gradients, no
blur — verified programmatically against the running app. One accent colour,
reserved for current state and primary actions.

Two encodings are used deliberately:

- **Segmented meters** (five discrete blocks) for skill levels, because level is
  ordinal. Dashed blocks show the gap to target.
- **Continuous bars** only for genuine percentages.

Theming is three-state: light, dark, and follow-the-OS. Light is defined on bare
`:root`; dark is redefined twice — once under `prefers-color-scheme` guarded by
`:root:not([data-theme="light"])`, once under `:root[data-theme="dark"]` — so an
explicit choice wins in both directions. A blocking script in `index.html`
applies the stored choice before first paint, so there is no flash.

## The backend

`server/` is that service, and it is built the way this codebase is organised:
it imports `src/lib/` directly rather than keeping its own copy of the engine,
the catalogue or the types.

The division of labour is the point. Selection, ordering, scheduling and the
"why this?" reasons stay deterministic. A model is used only for language, at
three edges — reading a free-text goal into one of the four known goal ids,
wording an explanation, and wording an assistant reply — and each has a
deterministic fallback, so the whole thing runs with the network unplugged.

Every fact the model states about a plan is handed to it first: the goal, every
skill level against its target, the ordered path with each item's reasons, and
what is next. It is told those facts are its only source of truth, and any
number in its reply that does not appear in them causes the reply to be thrown
away in favour of the rules' own text.

Full API reference, including the assessment and mastery endpoints:
[`server/README.md`](server/README.md).

### How the UI is wired to it

The UI calls the API through `src/lib/api.ts`, and **every one of those calls
has a local fallback**, so the app still works with the backend stopped. That
is not a nicety: the demo has to survive a room with no wifi, and a server
that is merely slow must never block a click.

The policy lives in `src/store/useAppStore.ts`, in one shape:

| Action | First | Then | If the API is unreachable |
|---|---|---|---|
| `regenerate()` | local `buildPath()`, synchronously | `POST /api/path`, debounced 200ms | keeps the local path |
| `sendMessage()` | — | `POST /api/chat` | local `respond()` |
| Explain in prose | — | `POST /api/narrate` | the reasons, which are already on screen |

Two details that took a rewrite to get right:

- **The local engine answers first for paths.** A profile edit lands on the
  next frame exactly as it did before there was a backend; the server's answer
  replaces it when it arrives. Same engine on both sides today, so it is the
  same path — but the server's catalogue is what wins once there is a real one.
- **Only the newest request may write.** Drag a level slider and several
  requests are in flight at once. Without a token guard, an earlier, slower
  response lands last and puts a stale path on screen.

Every assistant turn records how it was answered, and the header badge says
whether the API is connected and whether it has a model. An app that silently
falls back looks identical to a connected one, which is exactly the confusion
worth spending a badge on.

### The assessment screen

`/assess` is the one screen with **no** offline fallback, and the reason is the
point: grading happens on the server because the answer keys must never be
sent to the browser. Everything else keeps working with the backend stopped.

The loop it closes:

1. Pick a skill — offered widest-gap-first, since those are the levels
   deciding what stays in the path.
2. Answer three questions, spread across difficulty bands.
3. The server grades them and updates a posterior over the six levels.
4. If 70%+ of that belief sits at or above the goal's target, the level is
   committed and **the path is recomputed from it**. Below 30%, the path keeps
   covering the skill. In between, nothing is committed and you get more
   questions.

Measured `ml` and `python` up to 4 on the seeded profile and the path goes
from 7 items / 186 hrs / 24 weeks to 5 items / 130 hrs / 17 weeks — two
courses dropped because they were no longer needed, not because anything
edited the plan directly.

## Known limitations

- The catalogue is mock data (~35 resources, 4 goal tracks). Goals outside those
  tracks are declined rather than guessed at.
- Weekly activity on the dashboard is a synthetic distribution of hours actually
  completed — a real build would read the platform's event log.
- State persists to `localStorage` only. The API is stateless — the client
  sends the profile and gets the recomputed result back — so there is still no
  store and no auth.
- A quiz result cannot lower a skill level that a completed course implies:
  `profileSkills()` takes the strongest evidence. The grade response reports
  this in `notes` rather than hiding it.
