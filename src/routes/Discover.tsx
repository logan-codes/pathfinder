/**
 * Discover — the catalogue, searchable, for the things you did not know to
 * ask for.
 *
 * The plan answers "what do I need next?". This answers the question before
 * it: what is out there, and why would I care? Everything on this screen is
 * deterministic and works with the server stopped — it reads the same
 * committed catalogue the engine plans from. The two model-shaped things
 * (asking the assistant about an item, checking a skill) hand off to the
 * places that already do them.
 *
 * The two buttons on each row are the point. "Interested" and "Not for me"
 * write to the same `interests` and `avoid` the questionnaire fills in, so
 * browsing here is another way of finishing onboarding — and the path is
 * rebuilt from it immediately, with whatever changed highlighted.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Compass, Heart, HeartOff, MessageSquare, Search, Sparkles, Target } from 'lucide-react'
import { RESOURCES, skillName } from '@/lib/catalog'
import { getGoal } from '@/lib/goals'
import { hours as fmtHours } from '@/lib/format'
import type { LearnerProfile, Resource, ResourceId } from '@/lib/types'
import { useAppStore } from '@/store/useAppStore'
import { TopicCheck } from '@/components/TopicCheck'
import { Badge, Empty, KindMark, Panel } from '@/components/ui'

/** What a row's two preference buttons can say about a resource. */
type Preference = 'interested' | 'not-for-me' | 'clear'

/** Rows past this stop being a result list and start being the catalogue. */
const MAX_RESULTS = 12

function haystack(resource: Resource): string {
  return [
    resource.title,
    resource.summary,
    resource.provider,
    resource.kind,
    ...(resource.tags ?? []),
    ...Object.keys(resource.teaches).map(skillName),
  ]
    .join(' ')
    .toLowerCase()
}

/** Every term has to match somewhere — an AND search, which narrows. */
function matches(resource: Resource, terms: string[]): boolean {
  const text = haystack(resource)
  return terms.every((term) => text.includes(term))
}

function DiscoverRow({
  resource,
  profile,
  isOpen,
  onOpen,
  onPrefer,
  onAsk,
  online,
  drilling,
  onDrill,
}: {
  resource: Resource
  profile: LearnerProfile
  isOpen: boolean
  onOpen: (id: ResourceId | null) => void
  onPrefer: (tags: string[], want: Preference, title: string) => void
  onAsk: (resource: Resource) => void
  online: boolean
  drilling: ResourceId | null
  onDrill: (id: ResourceId | null) => void
}) {
  const tags = resource.tags ?? []
  const liked = tags.some((tag) => profile.interests.includes(tag))
  const avoided = tags.some((tag) => profile.avoid.includes(tag))
  const teaches = Object.entries(resource.teaches)

  // What this unlocks: everything in the catalogue that asks for a skill it
  // teaches. Computed, not written — so it cannot go stale.
  const unlocks = RESOURCES.filter(
    (other) =>
      other.id !== resource.id &&
      Object.keys(other.requires ?? {}).some((skillId) => skillId in resource.teaches),
  ).slice(0, 3)

  return (
    <div className={`disc ${isOpen ? 'disc--on' : ''}`}>
      <div
        className="res res--clickable"
        role="button"
        tabIndex={0}
        onClick={() => onOpen(isOpen ? null : resource.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(isOpen ? null : resource.id)
          }
        }}
      >
        <KindMark kind={resource.kind} />
        <div className="res__main">
          <div className="res__title">{resource.title}</div>
          <div className="res__meta">
            <span>{resource.provider}</span>
            <span>{fmtHours(resource.hours)}</span>
            <span>L{resource.level}</span>
            {profile.completed.includes(resource.id) && <span>already done</span>}
          </div>
        </div>
        <div className="res__actions">
          {liked && <Badge tone="accent">Interested</Badge>}
          {avoided && <Badge tone="warn">Not for me</Badge>}
        </div>
      </div>

      {isOpen && (
        <div className="disc__body">
          <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
            {resource.summary}
          </p>

          <dl className="why__kv" style={{ marginTop: 'var(--s-3)' }}>
            <dt>Teaches</dt>
            <dd>
              {teaches.length === 0
                ? 'Nothing new — it applies what you already have.'
                : teaches.map(([skillId, level]) => (
                    <div key={skillId}>
                      {skillName(skillId)} <span className="mono faint">to {level}</span>
                    </div>
                  ))}
            </dd>
            {unlocks.length > 0 && (
              <>
                <dt>Opens up</dt>
                <dd>{unlocks.map((u) => u.title).join(', ')}</dd>
              </>
            )}
            {tags.length > 0 && (
              <>
                <dt>Tagged</dt>
                <dd>{tags.join(', ')}</dd>
              </>
            )}
          </dl>

          <div className="row row--wrap" style={{ gap: 'var(--s-2)', marginTop: 'var(--s-3)' }}>
            <button
              className="btn btn--sm"
              onClick={() => onPrefer(tags, liked ? 'clear' : 'interested', resource.title)}
            >
              <Heart size={13} /> {liked ? 'In your interests' : 'This interests me'}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => onPrefer(tags, avoided ? 'clear' : 'not-for-me', resource.title)}
            >
              <HeartOff size={13} /> {avoided ? 'Undo not for me' : 'Not for me'}
            </button>
            <button className="btn btn--sm" onClick={() => onAsk(resource)}>
              <MessageSquare size={13} /> Ask about it
            </button>
            {online && (
              <button
                className="btn btn--sm"
                onClick={() => onDrill(drilling === resource.id ? null : resource.id)}
              >
                <Target size={13} /> Test me on this
              </button>
            )}
          </div>

          {drilling === resource.id && (
            <TopicCheck
              resourceId={resource.id}
              mode="drill"
              onClose={() => onDrill(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

export function DiscoverRoute() {
  const profile = useAppStore((s) => s.profile)
  const setPreferences = useAppStore((s) => s.setPreferences)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const online = useAppStore((s) => s.connection.status === 'online')
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ResourceId | null>(null)
  const [drilling, setDrilling] = useState<ResourceId | null>(null)

  const goal = getGoal(profile.goalId)
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  const results = useMemo(() => {
    if (terms.length === 0) return []
    return RESOURCES.filter((resource) => matches(resource, terms)).slice(0, MAX_RESULTS)
    // `terms` is rebuilt each render from `query`, so key the memo on the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  /**
   * The serendipity row: things outside both the stated interests and the
   * goal's own skills. This is the actual answer to "show me something I did
   * not know I wanted" — a search box can only return what you thought to
   * type.
   */
  const unfamiliar = useMemo(() => {
    const goalSkills = new Set(Object.keys(goal?.target ?? {}))
    const known = new Set(profile.interests)
    return RESOURCES.filter((resource) => {
      const tags = resource.tags ?? []
      if (tags.length === 0) return false
      if (tags.some((tag) => known.has(tag))) return false
      if (tags.some((tag) => profile.avoid.includes(tag))) return false
      if (Object.keys(resource.teaches).some((skillId) => goalSkills.has(skillId))) return false
      return true
    }).slice(0, 4)
  }, [goal, profile.interests, profile.avoid])

  /**
   * Both lists move together: wanting something removes it from the avoid
   * list and the other way round, so the profile can never say both at once.
   */
  function prefer(tags: string[], want: Preference, title: string) {
    const interests = profile.interests.filter((tag) => !tags.includes(tag))
    const avoid = profile.avoid.filter((tag) => !tags.includes(tag))

    if (want === 'interested') interests.push(...tags)
    if (want === 'not-for-me') avoid.push(...tags)

    setPreferences(
      { interests, avoid },
      want === 'interested'
        ? `From saying "${title}" interests you.`
        : want === 'not-for-me'
          ? `From ruling out ${tags.join(', ')}.`
          : 'From clearing a preference.',
    )
  }

  function ask(resource: Resource) {
    void sendMessage(`What is "${resource.title}" about, and would it be worth my time?`)
    navigate('/')
  }


  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1>Discover</h1>
          <p>
            Search the catalogue for anything — including the subjects you assume are not for you.
            Marking something interesting rebuilds your path around it.
          </p>
        </div>
      </div>

      <div className="grid grid--split">
        <div className="stack stack--4">
          <Panel>
            <div className="disc__search">
              <Search size={15} className="faint" />
              <input
                className="input"
                type="search"
                value={query}
                placeholder="react, statistics, containers, anything"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search the catalogue"
              />
            </div>
          </Panel>

          {terms.length > 0 && (
            <Panel
              title={`${results.length} result${results.length === 1 ? '' : 's'}`}
              flush
            >
              {results.length === 0 ? (
                <div className="panel__body">
                  <p className="muted">
                    Nothing in the catalogue matches that. It holds {RESOURCES.length} resources,
                    so a narrower word usually finds more than a longer phrase.
                  </p>
                </div>
              ) : (
                <div className="rows">
                  {results.map((resource) => (
                    <DiscoverRow
                      key={resource.id}
                      resource={resource}
                      profile={profile}
                      isOpen={open === resource.id}
                      onOpen={setOpen}
                      onPrefer={prefer}
                      onAsk={ask}
                      online={online}
                      drilling={drilling}
                      onDrill={setDrilling}
                    />
                  ))}
                </div>
              )}
            </Panel>
          )}

          {terms.length === 0 && (
            <Panel
              title={
                <h3>
                  <Sparkles size={14} /> Outside your lane
                </h3>
              }
              flush
            >
              {unfamiliar.length === 0 ? (
                <div className="panel__body">
                  <p className="muted">
                    Your interests and your goal already cover the catalogue. Search for something
                    specific instead.
                  </p>
                </div>
              ) : (
                <div className="rows">
                  {unfamiliar.map((resource) => (
                    <DiscoverRow
                      key={resource.id}
                      resource={resource}
                      profile={profile}
                      isOpen={open === resource.id}
                      onOpen={setOpen}
                      onPrefer={prefer}
                      onAsk={ask}
                      online={online}
                      drilling={drilling}
                      onDrill={setDrilling}
                    />
                  ))}
                </div>
              )}
            </Panel>
          )}
        </div>

        <div className="rail">
          <Panel title="What this changes">
            <div className="stack stack--3">
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
                Interests break ties. When two resources close the same gap equally well, the one
                tagged with something you said you cared about wins.
              </p>
              <div className="divider" />
              <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.6 }}>
                "Not for me" is a preference, not a veto. If something you flagged is the only way
                to reach your goal it stays in the path, and the "why this?" panel says so
                outright rather than sneaking it past you.
              </p>
              <div className="divider" />
              <p className="faint" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.55 }}>
                Passing a test here raises the measured level and drops the content you no longer
                need — the opposite direction from the check on the path, and the same machinery.
              </p>
            </div>
          </Panel>

          {!goal && (
            <Panel title="No goal yet">
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Browsing works without one, but nothing here can be ranked against a destination
                until there is one.
              </p>
              <button
                className="btn btn--sm"
                style={{ marginTop: 'var(--s-3)' }}
                onClick={() => navigate('/')}
              >
                <Compass size={13} /> Set a goal
              </button>
            </Panel>
          )}
        </div>
      </div>

      {RESOURCES.length === 0 && (
        <Empty title="The catalogue is empty">
          Nothing to discover until <code>src/lib/catalog.ts</code> has resources in it.
        </Empty>
      )}
    </div>
  )
}
