/** Small presentation helpers. No domain logic. */

export function hours(n: number): string {
  if (n <= 0) return '0 hrs'
  if (n < 1) return '<1 hr'
  return `${n} hr${n === 1 ? '' : 's'}`
}

export function weeks(n: number): string {
  return `${n} week${n === 1 ? '' : 's'}`
}

export function pct(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 100)
}

export function pluralise(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

const KIND_MARK: Record<string, string> = {
  course: 'C',
  project: 'P',
  assessment: 'A',
}

export function kindMark(kind: string): string {
  return KIND_MARK[kind] ?? '?'
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
