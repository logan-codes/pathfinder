/**
 * Offline authoring tool for the assessment item bank.
 *
 *   npm run author:quiz -- --skill nlp --skill system-design --count 3
 *   npm run author:quiz -- --skill python --count 2 --dry-run
 *
 * This is the only place a model is allowed near quiz content, and it runs
 * at authoring time, not serving time. It appends to `data/quiz-bank.json`
 * with `reviewed: false`; a human flips that flag after checking the key.
 * The server warns on start about unreviewed items and `npm run smoke`
 * fails on them, so an unchecked item cannot quietly reach a learner.
 *
 * It never rewrites an existing item — ids already in the bank are left
 * exactly as they are, so response data collected against them stays valid.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { SKILL_BY_ID, skillName } from '../src/lib/catalog'
import { MODEL } from '../server/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const BANK_PATH = path.join(here, '..', 'data', 'quiz-bank.json')
const LABELS = ['a', 'b', 'c', 'd']

// ---- arguments ----------------------------------------------------------

interface Args {
  skills: string[]
  count: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { skills: [], count: 2, dryRun: false }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--skill') {
      const value = argv[++i]
      if (!value) fail('--skill needs a skill id')
      args.skills.push(...value.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (flag === '--count') {
      args.count = Number(argv[++i])
      if (!Number.isInteger(args.count) || args.count < 1 || args.count > 10) {
        fail('--count must be a whole number between 1 and 10')
      }
    } else if (flag === '--dry-run') {
      args.dryRun = true
    } else {
      fail(`Unknown argument: ${flag}`)
    }
  }

  if (args.skills.length === 0) fail('Nothing to do. Pass at least one --skill <id>.')
  const unknown = args.skills.filter((id) => !SKILL_BY_ID[id])
  if (unknown.length > 0) fail(`Not skills in the catalogue: ${unknown.join(', ')}`)

  return args
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

// ---- generation ---------------------------------------------------------

const GeneratedItem = z.object({
  difficulty: z
    .number()
    .int()
    .min(1)
    .max(5),
  stem: z.string().min(10),
  options: z.array(z.string().min(1)).length(4),
  answer_index: z.number().int().min(0).max(3),
  rationale: z.string().min(10),
})

const GeneratedBatch = z.object({
  items: z.array(GeneratedItem).min(1).max(10),
})

const SYSTEM = [
  'You write multiple-choice assessment items that measure whether a learner has a skill, for a learning-path product.',
  '',
  'Requirements for every item:',
  '- Exactly one option is defensibly correct. If two could be argued, rewrite the item.',
  '- Distractors must be plausible to someone who half-knows the topic, not obviously silly.',
  '- Test understanding, not recall of syntax trivia or version-specific details that age badly.',
  '- No "all of the above", no "none of the above", no negated stems.',
  '- Do not reference a specific library version, a dated tool, or anything that changes yearly.',
  '- The rationale explains why the answer is right in one or two sentences, and is shown after grading.',
  '',
  'Difficulty is on a 0-5 skill scale, and means "a learner at this level should get it right":',
  '  2 = novice, knows the basics',
  '  3 = working, uses this day to day',
  '  4 = strong, understands the failure modes',
  'Spread the difficulties across the batch rather than clustering them.',
].join('\n')

async function generate(
  client: Anthropic,
  skillId: string,
  count: number,
  existingStems: string[],
): Promise<z.infer<typeof GeneratedBatch>> {
  const avoid =
    existingStems.length > 0
      ? `\n\nThe bank already asks these. Do not duplicate or paraphrase them:\n${existingStems.map((s) => `- ${s}`).join('\n')}`
      : ''

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: 'high',
      format: betaZodOutputFormat(GeneratedBatch),
    },
    messages: [
      {
        role: 'user',
        content: `Write ${count} items for the skill "${skillName(skillId)}" (id: ${skillId}).${avoid}`,
      },
    ],
  })

  if (response.stop_reason === 'refusal') {
    throw new Error(`Model declined: ${response.stop_details?.explanation ?? 'no reason given'}`)
  }
  if (!response.parsed_output) throw new Error('Model returned no parseable output')

  return response.parsed_output
}

// ---- main ---------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn(
      '\n  No ANTHROPIC_API_KEY in the environment. The SDK will try an `ant auth login`\n' +
        '  profile; if there is none this will fail. That is correct — authoring needs a\n' +
        '  model, unlike the server, which runs fine without one.\n',
    )
  }

  const bank = JSON.parse(readFileSync(BANK_PATH, 'utf8')) as {
    items: Array<{
      id: string
      skillId: string
      difficulty: number
      stem: string
      options: Array<{ id: string; text: string }>
      answer: string
      rationale: string
      reviewed: boolean
    }>
    [key: string]: unknown
  }

  const client = new Anthropic()
  const added: typeof bank.items = []
  const rejected: string[] = []

  for (const skillId of args.skills) {
    const existing = bank.items.filter((item) => item.skillId === skillId)
    process.stdout.write(`  ${skillId}: generating ${args.count}... `)

    let batch: z.infer<typeof GeneratedBatch>
    try {
      batch = await generate(client, skillId, args.count, existing.map((item) => item.stem))
    } catch (error) {
      console.log('failed')
      console.error(`    ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    let nextIndex =
      existing.reduce((max, item) => {
        const match = item.id.match(/-(\d+)$/)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0) + 1

    let kept = 0
    for (const item of batch.items) {
      const texts = new Set(item.options.map((option) => option.trim().toLowerCase()))
      if (texts.size !== item.options.length) {
        rejected.push(`${skillId}: duplicate option text — "${item.stem.slice(0, 50)}"`)
        continue
      }

      added.push({
        id: `q-${skillId}-${nextIndex++}`,
        skillId,
        difficulty: item.difficulty,
        stem: item.stem.trim(),
        options: item.options.map((text, index) => ({ id: LABELS[index], text: text.trim() })),
        answer: LABELS[item.answer_index],
        rationale: item.rationale.trim(),
        // A human decides this, not the model that wrote the item.
        reviewed: false,
      })
      kept++
    }

    console.log(`${kept} kept`)
  }

  if (rejected.length > 0) {
    console.log('\n  Rejected before writing:')
    for (const reason of rejected) console.log(`    - ${reason}`)
  }

  if (added.length === 0) {
    console.log('\n  Nothing to add.\n')
    return
  }

  if (args.dryRun) {
    console.log(`\n  --dry-run: ${added.length} items generated, nothing written.\n`)
    console.log(JSON.stringify(added, null, 2))
    return
  }

  bank.items = [...bank.items, ...added]
  bank.authoredBy = 'hand-seeded + generated'
  writeFileSync(BANK_PATH, `${JSON.stringify(bank, null, 2)}\n`, 'utf8')

  console.log(`\n  Wrote ${added.length} items to data/quiz-bank.json.`)
  console.log('  They are marked reviewed: false. Before committing:')
  console.log('    1. Check every answer key yourself.')
  console.log('    2. Check no two options are defensibly correct.')
  console.log('    3. Set "reviewed": true on the ones that survive, delete the rest.')
  console.log('  `npm run smoke` fails while unreviewed items are in the bank.\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
