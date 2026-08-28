# Pathfinder API

Node + Express + TypeScript. It imports the same domain layer the UI uses
(`src/lib/`), so there is one engine, one catalogue and one set of types —
not a server copy that drifts from the client copy.

```bash
npm install
npm run server      # http://127.0.0.1:8787/api
```

```bash
npm run server:dev  # same, restarts on change
npm run server:check # typecheck the server project
npm run smoke        # exercise every route against a running server
```

No configuration is required. With no API key the server runs fully offline
and every route still answers — see [Degradation](#degradation).

## The shape of it

```
server/
  index.ts        app assembly, middleware order, listen
  config.ts       every env var, each with a working default
  http.ts         error envelope, validation, rate limiting
  schema.ts       Zod request schemas, checked against src/lib/types.ts
  llm.ts          the two model calls, and the fallback behind each
  mastery.ts      posterior over skill levels; the accept/ask-more/refresh rule
  quiz.ts         reads data/quiz-bank.json; grading; answer keys stay here
  routes/         one file per group of endpoints
data/
  quiz-bank.json  committed assessment items, authored offline
scripts/
  author-quiz.ts  the offline authoring tool (the only writer of that file)
  smoke.ts        end-to-end check
```

Where the work happens:

| Concern | Decided by | Model involved |
|---|---|---|
| Which resources go in the path | `selectItems()` in `src/lib/engine.ts` | no |
| What order they go in | `orderItems()` — prerequisite-aware | no |
| How long it takes | `PACE_HOURS` × total hours | no |
| Why each item is there | `explain()` — from the numbers that drove selection | no |
| Which goal a sentence means | `extractGoal()`, falling back to `matchGoal()` | **yes** |
| How the reasons are worded | `narrate()`, falling back to the templates | **yes** |
| How an assistant reply is worded | `converse()`, falling back to the rules' own text | **yes** |
| What a learner actually knows | `mastery.ts` — Bayesian update over answered items | no |

A model can therefore be wrong about a **word** or about **which of four
known goals** you meant. It cannot be wrong about a curriculum, because it is
never asked to produce one.

## Endpoints

All under `/api`. Request and response bodies are JSON.

### Deterministic — no network, no key, no budget

#### `GET /api`

The index. A browser gets a readable table of every endpoint; curl and `fetch`
get the same list as JSON. `GET /` redirects here, so neither the bare origin
nor the URL in the startup banner is a dead end.

Content negotiation breaks a tie on key order, and `curl` sends `Accept: */*` —
so `json` is registered first, or an API client would be handed a web page.

#### `GET /health`

Status, counts, and — the useful part — `llm.lastError`. A silent fallback is
the failure mode that hurts, because everything still responds and nobody
notices the model has been out of the loop since the first request.

#### `GET /catalog`
`{ skills, resources, tags, levelLabels, paceHours, paceLabels }`.

#### `GET /goals`
`{ goals }` — the four goal templates with their target skill profiles.

#### `POST /path`
```json
{ "profile": { "goalId": "ml-engineer", "completed": ["py-basics"], "pace": "steady" } }
```
Returns `{ path, goal, levels, gaps, weeklyHours }`. Every profile field has a
default, so `{"profile":{}}` is valid.

A profile with no goal is a normal state, not an error: the response is `200`
with `path: null` and a `reason`, so the client renders an empty state without
special-casing a status code.

Same profile in, same path out. `npm run smoke` asserts this.

#### `POST /profile/skills`
`{ levels, goalId, gaps }` — what the learner knows now and how far that is
from the goal. The profile screen needs this without generating a path.

#### `GET /quiz`
Bank metadata and per-skill coverage.

#### `GET /quiz/:skillId?count=3&seed=abc`
Questions **without their answers** — keys never leave `server/quiz.ts`. The
seed is echoed back; reusing it reproduces the same questions, which is what
makes a rehearsal repeatable and two learners comparable. Items are picked to
span difficulty bands rather than at random, because three easy questions tell
you almost nothing.

`404 no_items` for a skill the bank does not cover, with the covered list in
`error.details`.

#### `POST /quiz/grade`
```json
{ "profile": {...}, "skillId": "python",
  "answers": [{ "itemId": "q-python-1", "optionId": "a" }] }
```

Two rules are enforced here, and they are the reason this endpoint exists
rather than a client-side score:

**A result edits state, then the path is recomputed from it.** It never edits
the path. Editing the path directly accumulates inconsistency until the "why
this?" explanations start lying, which would cost the feature that justifies
the architecture. The response returns the updated `profile` and a `path`
rebuilt from it.

**A skip needs evidence.** `mastery` is a posterior over the six levels, not a
number. Content is only skipped when at least 70% of the mass sits at or above
the goal's target (`verdict: "accept"`). Below 30% the path keeps covering it
(`refresh`). In between, the verdict is `ask-more`, nothing is committed, and
`moreItems` carries fresh questions. Skipping on weak evidence is the
expensive error: the learner hits a wall several modules later with no idea
why.

`effectiveLevel` and `notes` are the honest part. `profileSkills()` takes the
strongest evidence for a skill, so a completed course can hold a level above a
weaker measurement — when that happens the response says so instead of
reporting a number the planner will not use.

### Model-backed — each with a deterministic fallback

Rate limited per IP (`PATHFINDER_LLM_RATE_LIMIT`, default 30/min). That is not
a security control; it stops a retry loop in the UI from draining the budget.

#### `POST /goal/extract`
```json
{ "text": "I want to put models into production", "profile": {...} }
```
Returns `{ goalId, confidence, restatement, signals, weeklyHours, source, degraded, goal }`.

`goalId` is always an id the catalogue knows, or `null` — the model picks from
a closed set and the id is re-checked against the catalogue before it can
reach the engine. `source` says who answered: `llm`, or `keywords` when the
model was unavailable, unsure (confidence below 0.55), or overruled.

#### `POST /chat`
```json
{ "text": "Why this order?", "profile": {...} }
```
Returns `{ reply, answeredBy, deterministicText, extraction, profile, profileChanged, path }`.

Three steps, and the order is the design:

1. The rule-based assistant answers from live engine output. This produces the
   facts, the attachment, and any side effect on the profile.
2. If the rules could not place the message against a goal, `extractGoal()`
   picks one from the closed set the catalogue knows. `extraction` is `null`
   for every other intent.
3. `converse()` rewrites the answer in prose, given the finished facts — the
   goal, every skill level against its target, the ordered path with each
   item's reasons, what is next, and the rules' own answer.

The model decides nothing in steps 1 and 3. It picks a goal id from a fixed
list, and it picks words. `answeredBy` says whether the prose is the model's
or the rules', and `deterministicText` carries what it was asked to rephrase,
so the two can be compared.

Two guards apply to step 3: the model is told the facts are its only source of
truth, and any integer in the reply that does not appear in those facts causes
the whole reply to be discarded in favour of the rules' text.

One case is handled here rather than in the assistant: "I want to be a devops
engineer **and I can do 12 hours a week**" states two things, and the
assistant answers the pace and returns. The route extracts the goal from the
same sentence so it is not dropped.

#### `POST /narrate`
```json
{ "profile": {...}, "resourceId": "linalg-ml", "style": "brief" }
```
Returns `{ text, source, degraded, reasons, closes }`.

The reasons are computed by the engine **before** the model is called and are
returned alongside the prose, so a client can render either. Two guards apply
to the output: the model is told never to introduce a fact not in the brief,
and any integer in the narration that does not appear in the facts causes the
narration to be discarded in favour of the template.

`404 not_in_path` if the resource is not in this profile's path.

## Degradation

The demo has to survive a room with no wifi. Every model call is wrapped so
that missing credentials, a timeout, a rate limit, a malformed response and a
refusal all land in the same place — the deterministic answer, with
`degraded: true` and a line in `llm.lastError`.

Proof, rather than assertion:

```bash
PATHFINDER_LLM=off npm run server   # in one terminal
npm run smoke                       # in another
```

`npm run smoke` passes 24/24 with the model off, with it on, and with it on
but unreachable. The only thing that changes is `source`.

To rehearse the offline path deliberately, set `PATHFINDER_LLM=off`.

## Errors

Every failure has the same shape:

```json
{ "error": { "code": "invalid_request", "message": "...", "details": [...] } }
```

| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | Body or query failed validation; `details` lists the fields |
| `invalid_json` | 400 | Body was not JSON |
| `unknown_items` | 400 | Graded answers reference items not in the bank |
| `not_in_path` | 404 | That resource is not in this profile's path |
| `no_items` | 404 | The bank has no questions for that skill |
| `not_found` | 404 | No such route — `GET /api` lists the real ones |
| `no_goal` | 409 | Narration was asked for on a profile with no goal |
| `rate_limited` | 429 | Per-IP ceiling on a model-backed route; `Retry-After` is set |
| `internal_error` | 500 | Ours. Logged in full, reported without detail |

## Configuration

See `.env.example`. Every variable has a working default; the file is a
reference, not a requirement.

## Extending the item bank

```bash
npm run author:quiz -- --skill nlp --skill system-design --count 3
```

Items are generated in batch, appended with `reviewed: false`, and never
overwrite an existing id — response data collected against an id stays valid.
Then a human checks the keys and flips the flag. The server warns on start
about unreviewed items and `npm run smoke` fails while any remain, so an
unchecked item cannot quietly reach a learner.

This is authoring, not serving. Generating a question per request would
destroy the properties that make an assessment worth having: items could not
be compared across learners, calibrated for difficulty from response data, or
A/B tested, and no human would ever have reviewed an answer key.

## Known limitations

- **No persistence and no auth.** The API is stateless: the client sends the
  profile and gets the recomputed result back. Real deployment needs a store
  and a session before anything here is multi-tenant.
- **A measurement cannot lower a level implied by history.** `profileSkills()`
  takes the maximum across evidence sources, so completing a course pins a
  floor. The grade response reports this in `notes` rather than hiding it. The
  fix is evidence-weighted profiling, which is a change to `profileSkills()`,
  not to anything here.
- **The rate limiter is in-process.** Fine for one instance; it resets on
  restart and does not coordinate across replicas.
- **The item bank is uneven.** 66 items across 25 skills: eight skills have
  four, the rest have two. A skill with only two cannot deliver the follow-up
  questions an inconclusive verdict asks for — the UI says so rather than
  offering a button that would fail. `npm run author:quiz` is how that gets
  deeper.
- **The catalogue is mock data.** 35 resources, 4 goal tracks. Goals outside
  those tracks are declined rather than guessed at — by design, and the smoke
  test asserts the extractor never invents an id.
