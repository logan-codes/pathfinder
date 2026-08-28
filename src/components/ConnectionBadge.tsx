/**
 * Says whether the API is answering, and whether it has a model.
 *
 * This exists because the app is designed to keep working when the backend
 * is not there — which is a good property and a terrible one to leave
 * invisible. Without this you cannot tell a connected app from a
 * disconnected one, and a silent fallback is the failure mode that wastes
 * an afternoon.
 *
 * Clicking it re-checks, so starting the server after the UI does not
 * require a reload.
 */

import { useAppStore } from '@/store/useAppStore'

export function ConnectionBadge() {
  const connection = useAppStore((s) => s.connection)
  const checkConnection = useAppStore((s) => s.checkConnection)

  const { status, model, error, pathSource } = connection

  const view =
    status === 'unknown'
      ? { tone: 'idle', label: 'Checking', title: 'Checking whether the API is running…' }
      : status === 'offline'
        ? {
            tone: 'warn',
            label: 'Local only',
            title: `API unreachable (${error ?? 'no reason given'}). Everything still works — the recommendation engine is running in this browser. Click to retry; start it with \`npm run server\`.`,
          }
        : model
          ? {
              tone: 'on',
              label: 'API + model',
              title: `Connected. Paths come from the API (${pathSource}); ${model} reads free-text goals and writes explanations, each with a deterministic fallback. Click to re-check.`,
            }
          : {
              tone: 'ok',
              label: 'API',
              title:
                'Connected, with no model configured — the server is answering deterministically. Add ANTHROPIC_API_KEY to .env and restart it to enable goal extraction and written explanations. Click to re-check.',
            }

  return (
    <button
      type="button"
      className={`conn conn--${view.tone}`}
      onClick={() => void checkConnection()}
      title={view.title}
    >
      <span className="conn__dot" aria-hidden="true" />
      <span>{view.label}</span>
    </button>
  )
}
