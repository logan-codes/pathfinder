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
  http.ts         error envelope, validation, rate limiting, optional API key
  schema.ts       Zod request schemas, checked against src/lib/types.ts
  providers.ts    the LangChain provider registry — keys, models, failover
  llm.ts          the three model calls, and the fallback behind each
  guard.ts        input screening and output validation, both deterministic
  budget.ts       process-wide ceiling on calls, tokens and estimated spend
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

Which *vendor* answers is a separate axis, and a configuration one. Every
model call goes through LangChain's `BaseChatModel`, so Anthropic, OpenAI,
Google, Groq and Mistral are all reachable through the same three edges —
see [Providers](#providers).

> **Why LangChain and not LangGraph.** The orchestration is already
> deterministic and lives in `src/lib/engine.ts`. There is no cyclic,
> model-driven control flow to schedule, no checkpointing, and no
> human-in-the-loop interrupt — the model calls are single-shot leaves. A
> graph runtime would add a scheduler nothing here would ever step through.
> What was actually needed is one uniform chat-model interface with portable
> structured output, which is plain LangChain.

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

Rate limited per IP (`PATHFINDER_LLM_RATE_LIMIT`, default 30/min) and counted
against the process-wide budget. The limiter bounds one client; the budget
bounds the bill.

All three accept an optional `"provider"` naming the vendor for that one call.
An unknown or unconfigured name is ignored and the normal chain answers.

#### `GET /providers`
Configuration, not a model call: which providers are registered, which have a
key, which model each would use, and the failover order. Keys are never
returned — `keyFingerprint` is eight hex characters of SHA-256, enough to
confirm which key is loaded and useless for anything else.

#### `POST /providers/check`
```json
{ "providers": ["anthropic", "openai"] }
```
One real, minimal call per provider. Returns `{ checked: [{ id, model, ok,
latencyMs, error }], summary }`. Omit the body to check every configured key.
This is the difference between a key being *set* and a key *working*; a
screenshot of environment variables proves the former only.

Checks run sequentially on purpose — firing five providers at once to prove
they work is a good way to hit five rate limits and prove the opposite.

#### `POST /goal/extract`
```json
{ "text": "I want to put models into production", "profile": {...} }
```
Returns `{ goalId, confidence, restatement, signals, weeklyHours, source, degraded, goal, provider, model, screening }`.

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

## Providers

Every model call resolves through `server/providers.ts`. A provider is
"configured" when one of its environment variables holds a key; nothing else
is needed to make it selectable.

| id | key | default model | package |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5` | `@langchain/anthropic` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` | `@langchain/openai` |
| `google` | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | `gemini-2.0-flash` | `@langchain/google-genai` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | `@langchain/groq` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` | `@langchain/mistralai` |

Three ways to choose one:

```bash
# 1. the default chain, tried left to right, unconfigured entries skipped
PATHFINDER_PROVIDERS=anthropic,openai,google,groq,mistral

# 2. per request — the named provider goes first, the rest stay as failover
curl -X POST localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"text":"i want to be an ml engineer","profile":{},"provider":"groq"}'

# 3. prove every key works
curl -X POST localhost:8787/api/providers/check
```

A provider that fails — bad key, outage, refusal, timeout — hands off to the
next in the chain before the deterministic fallback is used. That failover is
vendor-neutral, which is what makes "all the keys work" demonstrable rather
than asserted.

Structured output (goal extraction) is declared as a plain JSON Schema rather
than a Zod object, because that is what every provider's tool-calling layer
speaks natively — one schema crosses all five with no translation step. The
result is then re-validated with Zod anyway: structured output is a strong
constraint on a good day and a suggestion on a bad one.

Model packages load with a dynamic import. A provider whose package is not
installed reports itself unavailable instead of taking the server down, so a
slimmed-down install still boots.

## Guardrails

Deterministic and offline, all of them. A guardrail that needs a network call
is a guardrail that fails exactly when the network does.

**Inbound** (`guard.screenInput`, run once per message in the route):

| Check | What it does |
|---|---|
| Normalisation | NFKC, then strips control characters, zero-width and bidi overrides, and the Unicode Tags block — the invisible-instruction carriers |
| PII redaction | Emails, phone numbers, Luhn-valid card numbers and vendor-prefixed API keys are replaced before the text reaches a prompt, a log, or the persisted profile |
| Injection detection | Eight patterns: instruction override, prompt extraction, role reassignment, forged turns, forged fences, jailbreak jargon, exfiltration, authority claims |
| Harm routing | A crisis message gets a fixed, human answer and no plan change. Weapons and sexual content go to the rules |
| Fencing | Surviving text is wrapped in `<learner_text_{nonce}>` tags with a per-call random nonce, and the system prompt says that block is data, never instruction |

A message that trips injection detection is answered by the **rules**, with
the model taken out of the loop entirely (`PATHFINDER_INJECTION_POLICY`). It
costs nothing, because the rules always have an answer — and the learner's
genuine intent still survives: "ignore all previous instructions, also I want
to be an ML engineer" still sets the ML engineer goal, via keyword matching.

**Outbound** (`guard.validateOutput`, run on every model answer):

| Check | Rejects |
|---|---|
| `invented-number` | Any integer not present in the engine's fact sheet |
| `invented-entity` | A catalogue course, provider, goal or skill name the facts do not mention |
| `invented-link` | Any URL the engine did not produce |
| `forbidden-claim` | Job promises, salary claims, guarantees — prompted against before, enforced now |
| `prompt-leak` | Fence tags or fragments of the system prompt |
| `too-long` | Prose past the sentence and character ceilings |
| `formatting` | Headings and bullets where prose was asked for |

A failed check discards the model's answer and serves the deterministic text.
Both directions are counted in `/api/health` under `guardrails` — a guardrail
nobody can see firing is indistinguishable from one that does not work.

**Around the call:**

- **Budget** (`budget.ts`) — process-wide caps on calls, tokens and estimated
  USD. Exceeding one degrades to deterministic answers rather than erroring.
- **Auth** — set `PATHFINDER_API_KEY` and every route except the index and
  liveness needs `Authorization: Bearer <key>`. Comparison is over SHA-256
  digests, so it is constant-time and length-independent.
- **Headers** — `helmet`, with a per-request CSP nonce for the index page's
  inline stylesheet rather than a blanket `unsafe-inline`.
- **Trust proxy** — off unless `PATHFINDER_TRUST_PROXY` is set, so
  `X-Forwarded-For` cannot be used to forge a rate-limit identity.

## Degradation

The demo has to survive a room with no wifi. Every model call is wrapped so
that no configured provider, a timeout, a rate limit, an exhausted budget, a
malformed response, a refusal and a failed output check all land in the same
place — the deterministic answer, with `degraded: true` and a line in
`llm.lastError`.

Proof, rather than assertion:

```bash
PATHFINDER_LLM=off npm run server   # in one terminal
npm run smoke                       # in another
```

`npm run smoke` passes 26/26 with no provider configured, with one, with
several, and with a provider configured but unreachable. The only thing that
changes is `source`.

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
| `unknown_provider` | 400 | `/providers/check` was given a name that is not registered |
| `unauthorized` | 401 | `PATHFINDER_API_KEY` is set and no key was sent |
| `forbidden` | 403 | A key was sent and it was wrong |
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

- **No persistence, and auth is one shared secret.** The API is stateless: the
  client sends the profile and gets the recomputed result back.
  `PATHFINDER_API_KEY` is a door, not a user system — real deployment needs a
  store and a session before anything here is multi-tenant.
- **The injection detector is patterns, not a classifier.** It catches the
  copy-pasted attempts, which is what an ungated demo actually sees. The real
  defence is structural: the model picks from a closed enum, never decides
  what goes in a path, and has its prose checked against the engine's facts.
  Treat the pattern list as a way to avoid paying to be attacked, not as a
  boundary.
- **The budget is in-process, and its prices are estimates.** One node, reset
  on restart, with rough list prices that drift. It is a safety rail against a
  runaway loop, not accounting — read the vendor's dashboard for spend.
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
