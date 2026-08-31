/**
 * Goal templates. Each defines the target skill profile that the engine
 * measures a learner against.
 *
 * `keywords` are what the assistant matches free-text goal statements
 * against. In production this becomes an intent classifier / embedding
 * lookup; the rest of the pipeline is unchanged.
 */

import type { Goal } from './types.js'

export const GOALS: Goal[] = [
  {
    id: 'ml-engineer',
    title: 'Machine Learning Engineer',
    blurb: 'Build, train and ship models that run in production.',
    target: {
      python: 4,
      stats: 3,
      linalg: 3,
      ml: 4,
      'deep-learning': 4,
      wrangling: 4,
      mlops: 4,
      docker: 3,
    },
    weights: { ml: 1.4, 'deep-learning': 1.3, mlops: 1.2, python: 1.1 },
    keywords: [
      'machine learning',
      'ml engineer',
      'ai engineer',
      'deep learning',
      'neural network',
      'model',
      'pytorch',
      'tensorflow',
      'computer vision',
      'nlp',
      'llm',
    ],
  },
  {
    id: 'data-analyst',
    title: 'Data Analyst',
    blurb: 'Turn raw data into decisions people actually act on.',
    target: {
      sql: 4,
      python: 3,
      wrangling: 4,
      viz: 4,
      stats: 3,
      experiments: 4,
    },
    weights: { sql: 1.4, viz: 1.3, experiments: 1.2 },
    keywords: [
      'data analyst',
      'analytics',
      'analyst',
      'dashboard',
      'business intelligence',
      'bi',
      'reporting',
      'sql',
      'tableau',
      'power bi',
      'a/b test',
      'ab testing',
    ],
  },
  {
    id: 'fullstack',
    title: 'Full-Stack Web Developer',
    blurb: 'Own a web product from interface to database.',
    target: {
      'html-css': 3,
      javascript: 4,
      typescript: 3,
      react: 4,
      node: 4,
      'api-design': 4,
      testing: 3,
      git: 3,
    },
    weights: { react: 1.3, node: 1.3, 'api-design': 1.2 },
    keywords: [
      'full stack',
      'fullstack',
      'full-stack',
      'web developer',
      'web dev',
      'frontend',
      'front end',
      'backend',
      'back end',
      'react',
      'javascript',
      'website',
      'web app',
    ],
  },
  {
    id: 'cloud-devops',
    title: 'Cloud / DevOps Engineer',
    blurb: 'Run reliable infrastructure and make deploys boring.',
    target: {
      linux: 4,
      docker: 4,
      k8s: 4,
      'ci-cd': 4,
      cloud: 4,
      iac: 3,
      observability: 3,
      git: 3,
    },
    weights: { k8s: 1.3, cloud: 1.3, 'ci-cd': 1.2 },
    keywords: [
      'devops',
      'cloud',
      'sre',
      'infrastructure',
      'kubernetes',
      'docker',
      'aws',
      'azure',
      'gcp',
      'platform engineer',
      'deployment',
      'terraform',
    ],
  },
]

export const GOAL_BY_ID: Record<string, Goal> = Object.fromEntries(
  GOALS.map((g) => [g.id, g]),
)

export function getGoal(id: string | null): Goal | undefined {
  return id ? GOAL_BY_ID[id] : undefined
}

/**
 * Score a free-text statement against every goal and return the best match.
 * Returns null when nothing clears the confidence floor, so the assistant
 * can ask instead of guessing.
 */
export function matchGoal(text: string): { goal: Goal; score: number } | null {
  const haystack = text.toLowerCase()
  let best: { goal: Goal; score: number } | null = null

  for (const goal of GOALS) {
    let score = 0
    for (const kw of goal.keywords) {
      if (haystack.includes(kw)) {
        // Longer keyword matches are more specific, so weight them higher.
        score += kw.length > 8 ? 3 : 2
      }
    }
    if (haystack.includes(goal.title.toLowerCase())) score += 6
    if (score > 0 && (!best || score > best.score)) best = { goal, score }
  }

  return best && best.score >= 2 ? best : null
}
