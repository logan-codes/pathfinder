import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, RotateCcw, Send } from 'lucide-react'
import { getResource, skillName } from '@/lib/catalog'
import { getGoal } from '@/lib/goals'
import { hours as fmtHours, pluralise } from '@/lib/format'
import { useSkillLevels } from '@/store/selectors'
import { useAppStore } from '@/store/useAppStore'
import { KindMark, Meter, Panel } from '@/components/ui'
import type { ChatMessage } from '@/lib/types'

/** Minimal inline formatting: **bold** only. Keeps message text readable
 *  without pulling in a markdown dependency for one token of syntax. */
function inline(line: string) {
  return line
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        <span key={i}>{part}</span>
      ),
    )
}

function MessageBody({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: Array<{ type: 'p' | 'ul'; lines: string[] }> = []

  for (const line of lines) {
    const isBullet = line.startsWith('— ')
    const last = blocks[blocks.length - 1]
    if (isBullet && last?.type === 'ul') last.lines.push(line.slice(2))
    else if (isBullet) blocks.push({ type: 'ul', lines: [line.slice(2)] })
    else if (line.trim()) blocks.push({ type: 'p', lines: [line] })
  }

  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'ul' ? (
          <ul className="msg__list" key={i}>
            {block.lines.map((line, j) => (
              <li key={j}>
                <span className="bullet">{String(j + 1).padStart(2, '0')}</span>
                <span>{inline(line)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>{inline(block.lines[0])}</p>
        ),
      )}
    </>
  )
}

/** Structured payloads rendered under an assistant turn. */
function Attachment({ attachment }: { attachment: NonNullable<ChatMessage['attachment']> }) {
  const path = useAppStore((s) => s.path)
  const levels = useSkillLevels()
  const profile = useAppStore((s) => s.profile)
  const navigate = useNavigate()
  const goal = getGoal(profile.goalId)

  if (attachment.type === 'path-summary') {
    if (!path || !goal) return null
    return (
      <div className="msg__attach">
        <Panel
          title={goal.title}
          actions={
            <button className="btn btn--sm" onClick={() => navigate('/path')}>
              Open path <ArrowRight size={13} />
            </button>
          }
          flush
        >
          <div className="rows">
            {path.milestones.map((m, i) => (
              <div className="rowitem" key={m.id}>
                <span className="kind">{i + 1}</span>
                <div className="rowitem__main">
                  <div className="rowitem__title">{m.title}</div>
                  <div className="rowitem__meta">
                    <span>{pluralise(m.items.length, 'item')}</span>
                    <span>
                      {fmtHours(
                        m.items.reduce((sum, it) => sum + (getResource(it.resourceId)?.hours ?? 0), 0),
                      )}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    )
  }

  if (attachment.type === 'resources') {
    return (
      <div className="msg__attach">
        <Panel flush>
          <div className="rows">
            {attachment.ids.map((id) => {
              const r = getResource(id)
              if (!r) return null
              return (
                <div className="res" key={id}>
                  <KindMark kind={r.kind} />
                  <div className="res__main">
                    <div className="res__title">{r.title}</div>
                    <div className="res__meta">
                      <span>{r.provider}</span>
                      <span>{fmtHours(r.hours)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>
    )
  }

  // skills
  return (
    <div className="msg__attach">
      <Panel flush>
        <div className="rows">
          {attachment.ids.map((id) => {
            const target = goal?.target[id]
            return (
              <div className="rowitem" key={id}>
                <div className="rowitem__main">
                  <div className="rowitem__title">{skillName(id)}</div>
                </div>
                <Meter level={levels[id] ?? 0} target={target} small />
                <span className="mono faint" style={{ fontSize: 'var(--t-xs)', minWidth: 34, textAlign: 'right' }}>
                  {levels[id] ?? 0}/{target ?? 5}
                </span>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

/**
 * Says where a reply came from, but only when that is worth knowing: the
 * model actually read the goal, or the API was unreachable and the browser
 * answered instead. The ordinary case — the server answering from its rules
 * — says nothing, because a caption on every turn is just noise.
 */
function Via({ via }: { via?: ChatMessage['via'] }) {
  if (via === 'model') return <p className="msg__via">Written by the model, from the engine&rsquo;s numbers</p>
  if (via === 'local') return <p className="msg__via">Answered offline — the API was unreachable</p>
  return null
}

export function ChatRoute() {
  const messages = useAppStore((s) => s.messages)
  const thinking = useAppStore((s) => s.thinking)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const resetConversation = useAppStore((s) => s.resetConversation)

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || thinking) return

    setDraft('')
    // The store owns the turn: it asks the API, falls back to the local
    // assistant if the API cannot be reached, and applies the effects
    // either way. Nothing about that is this component's business.
    void sendMessage(trimmed)
  }

  const lastMessage = messages[messages.length - 1]
  const suggestions = !thinking && lastMessage?.role === 'assistant' ? lastMessage.suggestions : undefined

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef}>
        <div className="chat__thread">
          {messages.map((msg) => (
            <article className={`msg msg--${msg.role === 'user' ? 'user' : 'bot'}`} key={msg.id}>
              <div className="msg__avatar" aria-hidden="true">
                {msg.role === 'user' ? 'K' : 'P'}
              </div>
              <div className="msg__body">
                <MessageBody text={msg.text} />
                {msg.attachment && <Attachment attachment={msg.attachment} />}
                <Via via={msg.via} />
              </div>
            </article>
          ))}

          {thinking && (
            <article className="msg msg--bot">
              <div className="msg__avatar" aria-hidden="true">
                P
              </div>
              <div className="typing" aria-label="Assistant is thinking">
                <span />
                <span />
                <span />
              </div>
            </article>
          )}
        </div>
      </div>

      <div className="composer">
        <div className="composer__inner">
          {suggestions && suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="composer__box">
            <textarea
              ref={inputRef}
              className="composer__input"
              rows={1}
              placeholder="Describe your goal, or ask why something is in your path…"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = `${Math.min(160, el.scrollHeight)}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(draft)
                }
              }}
            />
            <button
              type="button"
              className="btn btn--primary btn--icon"
              disabled={!draft.trim() || thinking}
              onClick={() => send(draft)}
              aria-label="Send"
            >
              <Send size={14} />
            </button>
          </div>

          <div className="composer__hint">
            <kbd>Enter</kbd> to send
            <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
            <span className="spacer" />
            <button className="btn btn--ghost btn--sm" onClick={resetConversation}>
              <RotateCcw size={12} /> Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
