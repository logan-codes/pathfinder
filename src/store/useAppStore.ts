/**
 * Single application store.
 *
 * Everything the UI reads lives here. Actions are the only way state
 * changes, and each one that affects recommendations calls back into the
 * engine so the path, dashboard and assistant never disagree.
 *
 * The API is an upgrade, not a dependency. Every network action here has
 * the same shape: answer locally first (or on failure), then let the server
 * replace the answer if it arrives. The app therefore works with the
 * backend stopped, which is deliberate — the demo has to survive a room
 * with no wifi, and a server that is merely slow must never block a click.
 *
 * What the server actually adds is the two model edges: turning a free-text
 * goal into one of the known goal ids, and writing prose explanations. Path
 * generation runs the same `src/lib/engine.ts` on both sides, so the local
 * answer and the server answer are the same path.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ApiError, getHealth, postChat, postPath } from '@/lib/api'
import { respond, type AssistantReply } from '@/lib/assistant'
import { buildPath, pathResourceIds } from '@/lib/engine'
import { uid } from '@/lib/format'
import type {
  ChatMessage,
  ItemStatus,
  LearnerProfile,
  LearningPath,
  Level,
  Pace,
  ResourceId,
  SkillId,
} from '@/lib/types'

export type ThemeChoice = 'light' | 'dark' | 'system'

const THEME_KEY = 'pf-theme'

function readStoredTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* private mode / blocked storage — fall through to default */
  }
  return 'system'
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    /* not fatal — the choice just will not persist */
  }
}

/** A learner with some history, so the demo is not a cold start. */
const DEFAULT_PROFILE: LearnerProfile = {
  name: 'Kiran',
  experience: 'some',
  interests: ['machine learning', 'ai', 'analytics'],
  completed: ['py-basics', 'sql-essentials'],
  selfRated: {},
  goalId: null,
  goalStatement: '',
  pace: 'steady',
}

const GREETING: ChatMessage = {
  id: 'greeting',
  role: 'assistant',
  text: "Tell me what you're trying to get to — a role, a project you want to build, or a skill you need for work. Plain language is fine; I'll ask about anything I need.",
  suggestions: [
    'I want to become a machine learning engineer',
    'Help me move into data analytics',
    'I want to build and ship full-stack web apps',
    'I need to learn cloud and DevOps for my job',
  ],
  at: Date.now(),
}

export type ConnectionStatus = 'unknown' | 'online' | 'offline'

export interface Connection {
  status: ConnectionStatus
  /** The server's model id, or null when it is running deterministically. */
  model: string | null
  /** How the path currently in state was produced. */
  pathSource: 'local' | 'api'
  /** Why the last attempt failed, when it did. */
  error: string | null
  checkedAt: number | null
}

const OFFLINE: Connection = {
  status: 'unknown',
  model: null,
  pathSource: 'local',
  error: null,
  checkedAt: null,
}

/**
 * Readable, short, and honest about which layer failed. The distinction that
 * matters when the server is simply not running: in dev the request goes
 * through Vite's proxy, which answers 5xx itself rather than failing to
 * connect, so "no response" and "server error" are both really "it is down".
 */
function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timed out'
  if (error instanceof TypeError) return 'no response'
  if (error instanceof ApiError) {
    if (error.code === 'upstream_error' || error.code === 'bad_response') return 'not answering'
    return `${error.code} (${error.status})`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Only the newest request may write to the store. Drag a slider quickly and
 * several path requests are in flight at once; without this an earlier,
 * slower response can land last and put a stale path on screen.
 */
let pathToken = 0
let chatToken = 0

/** Coalesces the network half of a burst of edits into one request. */
let pathTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Typing a name or dragging a level slider fires an edit per keystroke or
 * step. The local rebuild is cheap enough to run on every one of them; a
 * request per keystroke is not, and most of those edits do not change the
 * plan at all. Long enough to coalesce a burst, short enough that nobody
 * waiting on the explicit Regenerate button notices it.
 */
const PATH_DEBOUNCE_MS = 200

/** A network call must never make a click feel broken. */
const PATH_TIMEOUT_MS = 6000
const CHAT_TIMEOUT_MS = 15000
const HEALTH_TIMEOUT_MS = 4000

/** Below this the typing indicator is a flicker rather than feedback. */
const MIN_THINKING_MS = 250

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface AppState {
  // ---- state ----
  theme: ThemeChoice
  profile: LearnerProfile
  path: LearningPath | null
  /** Progress per resource id. Absent means 'todo'. */
  status: Record<ResourceId, ItemStatus>
  messages: ChatMessage[]
  /** Assistant is composing — drives the typing indicator. */
  thinking: boolean
  /** Resource selected in the path view, shown in the explanation rail. */
  focusedResource: ResourceId | null
  /** Whether the API is answering, and what it is capable of. */
  connection: Connection

  // Derived state lives in `store/selectors.ts`, not here. A method that
  // builds a fresh object breaks zustand's snapshot identity check when
  // called inside a selector, which loops forever.

  // ---- actions ----
  setTheme: (choice: ThemeChoice) => void
  updateProfile: (patch: Partial<LearnerProfile>) => void
  /**
   * Replace the whole profile with one that came from outside — today, the
   * profile stored against a signed-in account. Distinct from
   * `updateProfile` because it is a wholesale swap rather than an edit, and
   * because it must not be echoed straight back to the server.
   */
  adoptProfile: (profile: LearnerProfile) => void
  toggleInterest: (tag: string) => void
  toggleCompleted: (id: ResourceId) => void
  setSelfRated: (skillId: SkillId, level: Level) => void
  setPace: (pace: Pace) => void
  setGoal: (goalId: string, statement?: string) => void
  regenerate: () => void
  setStatus: (id: ResourceId, status: ItemStatus) => void
  toggleDone: (id: ResourceId) => void
  focusResource: (id: ResourceId | null) => void
  pushMessage: (msg: Omit<ChatMessage, 'id' | 'at'>) => void
  setThinking: (v: boolean) => void
  resetConversation: () => void
  /** Ask the API what it is and whether it has a model. */
  checkConnection: () => Promise<void>
  /** One assistant turn, server-first with a local fallback. */
  sendMessage: (text: string) => Promise<void>
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => {
      /**
       * Commit a path and prune progress for anything no longer planned, so
       * the dashboard cannot count work that is not in the plan.
       */
      function commitPath(path: LearningPath | null, source: Connection['pathSource']) {
        const ids = new Set(pathResourceIds(path))
        set((s) => {
          const kept: Record<ResourceId, ItemStatus> = {}
          for (const [id, st] of Object.entries(s.status)) {
            if (ids.has(id)) kept[id] = st
          }
          return {
            path,
            status: kept,
            connection: { ...s.connection, pathSource: source },
          }
        })
      }

      function markOnline(model?: string | null) {
        set((s) => ({
          connection: {
            ...s.connection,
            status: 'online',
            model: model === undefined ? s.connection.model : model,
            error: null,
            checkedAt: Date.now(),
          },
        }))
      }

      /** The network half of `regenerate`, once a burst of edits has settled. */
      async function syncPath(profile: LearnerProfile, token: number) {
        try {
          const { path } = await postPath(profile, AbortSignal.timeout(PATH_TIMEOUT_MS))
          if (token !== pathToken) return // a newer edit superseded this one
          commitPath(path, 'api')
          markOnline()
        } catch (error) {
          if (token !== pathToken) return
          markOffline(error)
        }
      }

      function markOffline(error: unknown) {
        set((s) => ({
          connection: {
            ...s.connection,
            status: 'offline',
            model: null,
            error: describeError(error),
            checkedAt: Date.now(),
          },
        }))
      }

      return {
        theme: readStoredTheme(),
        profile: DEFAULT_PROFILE,
        path: null,
        status: {},
        messages: [GREETING],
        thinking: false,
        focusedResource: null,
        connection: OFFLINE,

        // ---- actions ----
        setTheme: (choice) => {
          applyTheme(choice)
          set({ theme: choice })
        },

        updateProfile: (patch) => {
          set((s) => ({ profile: { ...s.profile, ...patch } }))
          get().regenerate()
        },

        adoptProfile: (profile) => {
          // Defaults for anything an older stored profile predates, so a
          // profile saved before a field existed cannot arrive undefined.
          set({ profile: { ...DEFAULT_PROFILE, ...profile } })
          get().regenerate()
        },

        toggleInterest: (tag) => {
          set((s) => {
            const has = s.profile.interests.includes(tag)
            return {
              profile: {
                ...s.profile,
                interests: has
                  ? s.profile.interests.filter((t) => t !== tag)
                  : [...s.profile.interests, tag],
              },
            }
          })
          get().regenerate()
        },

        /**
         * Editing history from the profile page. Keeps path status in step so
         * the two views cannot disagree about whether something is finished,
         * then re-plans, since changing your history changes what you need.
         */
        toggleCompleted: (id) => {
          set((s) => {
            const has = s.profile.completed.includes(id)
            const status = { ...s.status }
            if (has) delete status[id]
            else if (id in status) status[id] = 'done'

            return {
              status,
              profile: {
                ...s.profile,
                completed: has
                  ? s.profile.completed.filter((c) => c !== id)
                  : [...s.profile.completed, id],
              },
            }
          })
          get().regenerate()
        },

        setSelfRated: (skillId, level) => {
          set((s) => ({
            profile: { ...s.profile, selfRated: { ...s.profile.selfRated, [skillId]: level } },
          }))
          get().regenerate()
        },

        setPace: (pace) => {
          set((s) => ({ profile: { ...s.profile, pace } }))
          get().regenerate()
        },

        setGoal: (goalId, statement) => {
          set((s) => ({
            profile: {
              ...s.profile,
              goalId,
              goalStatement: statement ?? s.profile.goalStatement,
            },
          }))
          get().regenerate()
        },

        /**
         * Rebuild the path from the current profile.
         *
         * The local engine answers first and synchronously, so a profile edit
         * lands on the next frame exactly as it did before there was a
         * backend. The API is then asked the same question, debounced, and
         * its answer replaces the local one — the same engine on both sides
         * today, but it is the server's catalogue that wins once there is a
         * real one.
         */
        regenerate: () => {
          const profile = get().profile
          const token = ++pathToken

          commitPath(buildPath(profile), 'local')

          if (pathTimer !== null) clearTimeout(pathTimer)
          pathTimer = setTimeout(() => {
            pathTimer = null
            void syncPath(profile, token)
          }, PATH_DEBOUNCE_MS)
        },

        setStatus: (id, status) => set((s) => ({ status: { ...s.status, [id]: status } })),

        /**
         * Completing a path item is also a fact about the learner's history,
         * so it updates both. Without this the dashboard would show progress
         * while skill levels sat still.
         *
         * It deliberately does NOT regenerate: the path is a plan the learner
         * has committed to, and having items vanish underneath them as they
         * finish would be hostile. Re-planning is an explicit action.
         */
        toggleDone: (id) =>
          set((s) => {
            const nowDone = s.status[id] !== 'done'
            const completed = nowDone
              ? s.profile.completed.includes(id)
                ? s.profile.completed
                : [...s.profile.completed, id]
              : s.profile.completed.filter((c) => c !== id)

            return {
              status: { ...s.status, [id]: nowDone ? 'done' : 'todo' },
              profile: { ...s.profile, completed },
            }
          }),

        focusResource: (id) => set({ focusedResource: id }),

        pushMessage: (msg) =>
          set((s) => ({ messages: [...s.messages, { ...msg, id: uid('msg'), at: Date.now() }] })),

        setThinking: (v) => set({ thinking: v }),

        resetConversation: () => set({ messages: [{ ...GREETING, at: Date.now() }] }),

        checkConnection: async () => {
          try {
            const health = await getHealth(AbortSignal.timeout(HEALTH_TIMEOUT_MS))
            // The server can front several providers, so the label names the
            // one that would answer next rather than a single configured
            // model. An unauthenticated health check omits `llm` entirely.
            const chain = health.llm?.chain ?? []
            const provider = health.llm?.providers.find((p) => p.id === chain[0])
            markOnline(
              health.llm?.enabled && provider ? `${provider.id}/${provider.model}` : null,
            )
          } catch (error) {
            markOffline(error)
          }
        },

        /**
         * One assistant turn.
         *
         * The server is asked first, because it is the only side that can
         * reach a model — which matters for exactly one thing: understanding
         * a goal statement that keyword matching misses. Everything else it
         * answers is the same rule-based reply this store can produce itself,
         * which is what makes the fallback a genuine substitute rather than a
         * degraded stub.
         */
        sendMessage: async (text) => {
          const trimmed = text.trim()
          if (!trimmed || get().thinking) return

          const token = ++chatToken
          const startedAt = Date.now()

          get().pushMessage({ role: 'user', text: trimmed })
          set({ thinking: true })

          const profile = get().profile
          let reply: AssistantReply
          let via: ChatMessage['via']

          try {
            const result = await postChat(trimmed, profile, {
              signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
            })
            if (token !== chatToken) return
            reply = result.reply
            // The server says who wrote the words: the model, or its own
            // rules when the model was unavailable or produced something
            // that failed the grounding check.
            via = result.answeredBy === 'model' ? 'model' : 'server'
            markOnline()
          } catch (error) {
            if (token !== chatToken) return
            reply = respond(trimmed, { profile, path: get().path })
            via = 'local'
            markOffline(error)
          }

          // Effects are applied through the normal actions rather than from
          // the server's echoed profile, so there is exactly one code path
          // that mutates the profile and re-plans. The server also returns a
          // recomputed path; it is ignored on purpose, because `setGoal`
          // triggers `regenerate()` and that path is built from the same
          // engine, from the goal id the server just resolved.
          if (reply.effects?.setGoal) {
            get().setGoal(reply.effects.setGoal.goalId, reply.effects.setGoal.statement)
          }
          if (reply.effects?.setPace) get().setPace(reply.effects.setPace)

          const elapsed = Date.now() - startedAt
          if (elapsed < MIN_THINKING_MS) await wait(MIN_THINKING_MS - elapsed)
          if (token !== chatToken) return

          set({ thinking: false })
          get().pushMessage({
            role: 'assistant',
            text: reply.text,
            attachment: reply.attachment,
            suggestions: reply.suggestions,
            via,
          })
        },
      }
    },
    {
      name: 'pf-state',
      // The path is derived, so it is not persisted — it is rebuilt from the
      // profile on rehydration. Persisting it would risk a stale path
      // surviving a change to the engine or catalogue.
      partialize: (s) => ({
        profile: s.profile,
        status: s.status,
        messages: s.messages,
      }),
      onRehydrateStorage: () => (state) => {
        state?.regenerate()
      },
    },
  ),
)
