/**
 * End-to-end check against a running server.
 *
 *   npm run server      (in one terminal)
 *   npm run smoke       (in another)
 *
 * It exercises every route, checks the shapes the UI depends on, and proves
 * the two properties that matter for the demo: the deterministic routes are
 * reproducible, and answer keys never leave the server.
 *
 * It passes whether or not a model is configured — that is the point.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8787}/api`

const bank = JSON.parse(
  readFileSync(path.join(here, '..', 'data', 'quiz-bank.json'), 'utf8'),
) as { items: Array<{ id: string; answer: string; options: Array<{ id: string }> }> }

const answerKey = new Map(bank.items.map((item) => [item.id, item.answer]))
const wrongKey = new Map(
  bank.items.map((item) => [
    item.id,
    item.options.find((option) => option.id !== item.answer)!.id,
  ]),
)

const PROFILE = {
  name: 'Smoke',
  experience: 'some',
  interests: ['machine learning', 'analytics'],
  completed: ['py-basics', 'sql-essentials'],
  selfRated: {},
  goalId: 'ml-engineer',
  goalStatement: 'I want to become a machine learning engineer',
  pace: 'steady',
}

const NO_GOAL = { ...PROFILE, goalId: null, goalStatement: '' }

interface Outcome {
  name: string
  ok: boolean
  detail: string
}

const outcomes: Outcome[] = []

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    outcomes.push({ name, ok: true, detail: await fn() })
  } catch (error) {
    outcomes.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function api(
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${route} returned non-JSON (${response.status}): ${text.slice(0, 120)}`)
  }
  return { status: response.status, json }
}

async function ok(method: 'GET' | 'POST', route: string, body?: unknown): Promise<any> {
  const { status, json } = await api(method, route, body)
  assert(
    status === 200,
    `${method} ${route} expected 200, got ${status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`,
  )
  return json
}

async function main(): Promise<void> {
  let llmEnabled = false

  await check('GET /health', async () => {
    const health = await ok('GET', '/health')
    assert(health.ok === true, 'health.ok is not true')
    assert(health.quiz.items > 0, 'the item bank is empty')
    assert(health.quiz.unreviewed.length === 0, 'the bank contains unreviewed items')
    llmEnabled = Boolean(health.llm.enabled)
    return `${health.catalog.resources} resources, ${health.quiz.items} quiz items, model ${llmEnabled ? health.llm.model : 'off'}`
  })

  await check('GET /api lists its own routes', async () => {
    const index = await ok('GET', '')
    assert(Array.isArray(index.endpoints), 'the index did not list endpoints')
    assert(
      index.endpoints.every((e: { path: string }) => e.path.startsWith('/api/')),
      'an endpoint in the index is not under /api',
    )

    // The list is hand-written, so check it has not drifted from reality:
    // every plain GET it advertises must actually answer.
    const gettable = index.endpoints.filter(
      (e: { method: string; path: string }) => e.method === 'GET' && !e.path.includes(':'),
    )
    for (const endpoint of gettable) {
      const { status } = await api('GET', endpoint.path.replace('/api', ''))
      assert(status !== 404, `the index advertises ${endpoint.path}, which 404s`)
    }
    return `${index.endpoints.length} routes listed, ${gettable.length} probed`
  })

  await check('GET /api negotiates html vs json', async () => {
    const asBrowser = await fetch(BASE, {
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    })
    const asClient = await fetch(BASE, { headers: { accept: 'application/json' } })
    assert(
      asBrowser.headers.get('content-type')?.includes('text/html'),
      'a browser did not get the HTML index',
    )
    assert(
      asClient.headers.get('content-type')?.includes('application/json'),
      'an API client did not get JSON',
    )
    return 'browser gets html, clients get json'
  })

  await check('GET /catalog', async () => {
    const catalog = await ok('GET', '/catalog')
    assert(catalog.skills.length > 0 && catalog.resources.length > 0, 'catalogue is empty')
    return `${catalog.skills.length} skills, ${catalog.tags.length} tags`
  })

  await check('GET /goals', async () => {
    const { goals } = await ok('GET', '/goals')
    assert(goals.length > 0, 'no goal templates')
    return goals.map((goal: { id: string }) => goal.id).join(', ')
  })

  await check('POST /path builds a plan', async () => {
    const result = await ok('POST', '/path', { profile: PROFILE })
    assert(result.path, 'no path returned')
    assert(result.path.milestones.length > 0, 'path has no milestones')
    assert(result.path.totalHours > 0, 'path has no hours')
    const items = result.path.milestones.flatMap((m: { items: unknown[] }) => m.items)
    assert(items.length > 0, 'path has no items')
    return `${items.length} items, ${result.path.totalHours}h, ${result.path.weeks} weeks, ${result.gaps.length} tracked skills`
  })

  await check('POST /path is deterministic', async () => {
    const a = await ok('POST', '/path', { profile: PROFILE })
    const b = await ok('POST', '/path', { profile: PROFILE })
    const ids = (r: any) =>
      r.path.milestones.flatMap((m: any) => m.items.map((i: any) => i.resourceId)).join(',')
    assert(ids(a) === ids(b), 'the same profile produced two different paths')
    return ids(a)
  })

  await check('POST /path with no goal', async () => {
    const result = await ok('POST', '/path', { profile: NO_GOAL })
    assert(result.path === null, 'expected a null path with no goal set')
    assert(typeof result.reason === 'string', 'expected a reason')
    return result.reason
  })

  await check('POST /path accepts an empty profile', async () => {
    const result = await ok('POST', '/path', { profile: {} })
    assert(result.path === null, 'a profile with no goal should give a null path')
    return 'defaults applied, no validation error'
  })

  await check('POST /profile/skills', async () => {
    const result = await ok('POST', '/profile/skills', { profile: PROFILE })
    assert(result.levels.python >= 3, 'completing py-basics should imply python >= 3')
    assert(result.gaps.length > 0, 'expected open gaps against ml-engineer')
    return `python=${result.levels.python}, ${result.gaps.length} target skills`
  })

  await check('POST /goal/extract (clear statement)', async () => {
    const result = await ok('POST', '/goal/extract', {
      text: 'I want to become a machine learning engineer and ship models to production',
    })
    assert(result.goalId === 'ml-engineer', `expected ml-engineer, got ${result.goalId}`)
    assert(['llm', 'keywords'].includes(result.source), 'unexpected source')
    return `${result.goalId} via ${result.source} (confidence ${result.confidence})`
  })

  await check('POST /goal/extract (nothing to match)', async () => {
    const result = await ok('POST', '/goal/extract', { text: 'what is the weather today' })
    // Offline this is null. With a model it may still be null, and must never
    // be a goal id the catalogue does not know.
    assert(
      result.goalId === null || typeof result.goalId === 'string',
      'goalId must be null or a known id',
    )
    assert(result.goal !== undefined, 'expected a goal field')
    return `goalId=${result.goalId} via ${result.source}`
  })

  await check('POST /chat sets a goal and returns the plan', async () => {
    const result = await ok('POST', '/chat', {
      text: 'Help me move into data analytics',
      profile: NO_GOAL,
    })
    assert(
      result.reply.effects?.setGoal?.goalId === 'data-analyst',
      `expected data-analyst, got ${result.reply.effects?.setGoal?.goalId}`,
    )
    assert(result.profile.goalId === 'data-analyst', 'the echoed profile was not updated')
    assert(result.path && result.path.milestones.length > 0, 'no path recomputed')
    assert(
      ['model', 'rules'].includes(result.answeredBy),
      `unexpected answeredBy: ${result.answeredBy}`,
    )
    assert(
      typeof result.deterministicText === 'string' && result.deterministicText.length > 0,
      'the rule-based answer was not returned alongside the prose',
    )
    return `${result.path.milestones.length} milestones, answered by ${result.answeredBy}`
  })

  await check('POST /chat answers "why this order?" without the model', async () => {
    const result = await ok('POST', '/chat', { text: 'Why this order?', profile: PROFILE })
    assert(result.reply.intent === 'why-order', `unexpected intent ${result.reply.intent}`)
    // The rules still decide the intent and the facts; only the wording can
    // come from a model, and no goal extraction should have run.
    assert(result.extraction === null, 'goal extraction should not run for this intent')
    return `${result.reply.intent}, answered by ${result.answeredBy}`
  })

  await check('POST /chat keeps the goal in a combined message', async () => {
    const result = await ok('POST', '/chat', {
      text: 'I want to be a cloud devops engineer and I can do 12 hours a week',
      profile: NO_GOAL,
    })
    assert(result.reply.effects?.setPace === 'intense', 'pace was not picked up')
    assert(
      result.reply.effects?.setGoal?.goalId === 'cloud-devops',
      'the goal in the same sentence was dropped',
    )
    return `pace=${result.reply.effects.setPace}, goal=${result.reply.effects.setGoal.goalId}`
  })

  let narrated = ''
  await check('POST /narrate', async () => {
    const { path: plan } = await ok('POST', '/path', { profile: PROFILE })
    const first = plan.milestones[0].items[0].resourceId
    const result = await ok('POST', '/narrate', { profile: PROFILE, resourceId: first })
    assert(result.text.length > 0, 'empty narration')
    assert(['llm', 'template'].includes(result.source), 'unexpected source')
    assert(result.reasons.length > 0, 'narration returned without its underlying reasons')
    narrated = result.source
    return `${first} via ${result.source}: ${result.text.slice(0, 70)}...`
  })

  await check('POST /narrate rejects a resource not in the path', async () => {
    const { status, json } = await api('POST', '/narrate', {
      profile: PROFILE,
      resourceId: 'not-a-real-resource',
    })
    assert(status === 404, `expected 404, got ${status}`)
    assert(json.error.code === 'not_in_path', `unexpected code ${json.error.code}`)
    return json.error.code
  })

  let quizItems: Array<{ id: string; difficulty: number }> = []
  await check('GET /quiz/:skillId hides the answers', async () => {
    const result = await ok('GET', '/quiz/python?count=2&seed=demo')
    assert(result.items.length === 2, `expected 2 items, got ${result.items.length}`)
    const serialised = JSON.stringify(result.items)
    assert(!serialised.includes('"answer"'), 'an answer key leaked to the client')
    assert(!serialised.includes('"rationale"'), 'a rationale leaked before grading')
    quizItems = result.items
    return result.items.map((item: { id: string }) => item.id).join(', ')
  })

  await check('GET /quiz/:skillId is reproducible for a seed', async () => {
    const a = await ok('GET', '/quiz/ml?count=2&seed=fixed')
    const b = await ok('GET', '/quiz/ml?count=2&seed=fixed')
    assert(
      JSON.stringify(a.items) === JSON.stringify(b.items),
      'the same seed produced different questions',
    )
    return 'same seed, same questions'
  })

  await check('GET /quiz/:skillId 404s for an uncovered skill', async () => {
    const { status, json } = await api('GET', '/quiz/nlp')
    assert(status === 404, `expected 404, got ${status}`)
    assert(Array.isArray(json.error.details.skillsWithItems), 'expected a coverage hint')
    return `${json.error.code}, ${json.error.details.skillsWithItems.length} covered skills`
  })

  await check('POST /quiz/grade — all correct', async () => {
    const result = await ok('POST', '/quiz/grade', {
      profile: PROFILE,
      skillId: 'python',
      answers: quizItems.map((item) => ({
        itemId: item.id,
        optionId: answerKey.get(item.id)!,
      })),
    })
    assert(result.score.correct === quizItems.length, 'grading marked a correct answer wrong')
    assert(result.mastery.source === 'verified', 'answering should make mastery verified')
    assert(result.path, 'the path was not recomputed')
    assert(result.details.every((d: any) => typeof d.rationale === 'string'), 'no rationale')
    return `level ${result.mastery.level} (confidence ${result.mastery.confidence}), verdict ${result.verdict?.verdict}`
  })

  await check('POST /quiz/grade — all wrong lands lower', async () => {
    const right = await ok('POST', '/quiz/grade', {
      profile: PROFILE,
      skillId: 'python',
      answers: quizItems.map((i) => ({ itemId: i.id, optionId: answerKey.get(i.id)! })),
    })
    const wrong = await ok('POST', '/quiz/grade', {
      profile: PROFILE,
      skillId: 'python',
      answers: quizItems.map((i) => ({ itemId: i.id, optionId: wrongKey.get(i.id)! })),
    })
    assert(
      wrong.mastery.expected < right.mastery.expected,
      `wrong answers did not lower the estimate (${wrong.mastery.expected} vs ${right.mastery.expected})`,
    )
    return `expected level ${wrong.mastery.expected} wrong vs ${right.mastery.expected} right`
  })

  await check('POST /quiz/grade rejects unknown items', async () => {
    const { status, json } = await api('POST', '/quiz/grade', {
      profile: PROFILE,
      skillId: 'python',
      answers: [{ itemId: 'q-does-not-exist', optionId: 'a' }],
    })
    assert(status === 400, `expected 400, got ${status}`)
    assert(json.error.code === 'unknown_items', `unexpected code ${json.error.code}`)
    return json.error.code
  })

  await check('malformed body is a 400, not a 500', async () => {
    const { status, json } = await api('POST', '/path', { profile: { pace: 'sprint' } })
    assert(status === 400, `expected 400, got ${status}`)
    assert(json.error.code === 'invalid_request', `unexpected code ${json.error.code}`)
    return `${json.error.details[0].path}: ${json.error.details[0].message}`
  })

  await check('unknown route is a 404', async () => {
    const { status, json } = await api('GET', '/nope')
    assert(status === 404, `expected 404, got ${status}`)
    assert(json.error.code === 'not_found', `unexpected code ${json.error.code}`)
    return json.error.message
  })

  await check('the model never invents a goal id', async () => {
    const { goals } = await ok('GET', '/goals')
    const known = new Set(goals.map((goal: { id: string }) => goal.id))
    const probes = [
      'I want to be a quantum blockchain astronaut',
      'help me learn to bake sourdough',
      'asdkjfh askjdfh',
    ]
    for (const text of probes) {
      const result = await ok('POST', '/goal/extract', { text })
      assert(
        result.goalId === null || known.has(result.goalId),
        `extractor returned an unknown goal id: ${result.goalId}`,
      )
    }
    return `${probes.length} probes, no invented ids`
  })

  // ---- report ----------------------------------------------------------

  const width = Math.max(...outcomes.map((outcome) => outcome.name.length))
  console.log('')
  for (const outcome of outcomes) {
    console.log(
      `  ${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.name.padEnd(width)}  ${outcome.detail}`,
    )
  }

  const failed = outcomes.filter((outcome) => !outcome.ok)
  console.log('')
  console.log(
    `  ${outcomes.length - failed.length}/${outcomes.length} passed against ${BASE}` +
      `  (model ${llmEnabled ? 'enabled' : 'off'}, narration via ${narrated || 'n/a'})`,
  )
  console.log('')

  if (failed.length > 0) process.exit(1)
}

main().catch((error) => {
  console.error(`\n  Could not reach ${BASE}. Is \`npm run server\` running?\n`)
  console.error(error)
  process.exit(1)
})
