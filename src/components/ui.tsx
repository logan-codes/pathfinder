/**
 * Presentational primitives. No store access, no domain logic — these take
 * props and render. Keeps routes readable and the visual language uniform.
 */

import type { ReactNode } from 'react'
import { kindMark } from '@/lib/format'
import { LEVEL_LABELS, type Level, type ResourceKind } from '@/lib/types'

/* ---------------- panel ---------------- */

export function Panel({
  title,
  actions,
  children,
  flush,
  sunken,
  className = '',
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
  sunken?: boolean
  className?: string
}) {
  return (
    <section className={`panel ${sunken ? 'panel--sunken' : ''} ${className}`}>
      {title && (
        <header className="panel__head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions && <div className="panel__head-actions">{actions}</div>}
        </header>
      )}
      <div className={`panel__body ${flush ? 'panel__body--flush' : ''}`}>{children}</div>
    </section>
  )
}

/* ---------------- badge ---------------- */

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'accent' | 'danger'
}) {
  const suffix = tone === 'neutral' ? '' : ` badge--${tone}`
  return <span className={`badge${suffix}`}>{children}</span>
}

/* ---------------- resource kind marker ---------------- */

export function KindMark({ kind }: { kind: ResourceKind }) {
  return (
    <span className={`kind kind--${kind}`} title={kind} aria-label={kind}>
      {kindMark(kind)}
    </span>
  )
}

/* ---------------- meters ---------------- */

/**
 * Five discrete blocks. Filled blocks are what the learner has; dashed
 * blocks are what the goal still asks for. Reads as a level, not a
 * percentage, which is the honest encoding for an ordinal scale.
 */
export function Meter({
  level,
  target,
  small,
}: {
  level: Level
  target?: Level
  small?: boolean
}) {
  const label = target
    ? `${LEVEL_LABELS[level]} of ${LEVEL_LABELS[target]} required`
    : LEVEL_LABELS[level]

  return (
    <span className={`meter ${small ? 'meter--sm' : ''}`} role="img" aria-label={label} title={label}>
      {([1, 2, 3, 4, 5] as const).map((i) => {
        const filled = i <= level
        const isGap = !filled && target != null && i <= target
        return (
          <span
            key={i}
            className={`meter__block ${filled ? 'meter__block--filled' : ''} ${
              isGap ? 'meter__block--gap' : ''
            }`}
          />
        )
      })}
    </span>
  )
}

export function Bar({ value, total, ok }: { value: number; total: number; ok?: boolean }) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`bar__fill ${ok ? 'bar__fill--ok' : ''}`} style={{ width: `${percent}%` }} />
    </div>
  )
}

/* ---------------- stat tile ---------------- */

export function Stat({
  label,
  value,
  unit,
  foot,
}: {
  label: string
  value: ReactNode
  unit?: string
  foot?: ReactNode
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <div className="stat__value">
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {foot && <div className="stat__foot">{foot}</div>}
    </div>
  )
}

/* ---------------- empty state ---------------- */

export function Empty({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

/* ---------------- field ---------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

/* ---------------- checkbox ---------------- */

export function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={`check ${checked ? 'check--on' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </button>
  )
}

/* ---------------- flat bar chart ---------------- */

/**
 * Hand-rolled SVG. Deliberately not a charting library: flat fills, one
 * accent colour, no gridline noise beyond a single baseline.
 */
export function BarChart({
  data,
  height = 96,
  ariaLabel,
}: {
  data: Array<{ label: string; value: number }>
  height?: number
  ariaLabel: string
}) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const barW = 100 / data.length
  const plotH = height - 20

  return (
    <svg
      className="chart"
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      {data.map((d, i) => {
        const h = (d.value / max) * plotH
        const x = i * barW + barW * 0.2
        const w = barW * 0.6
        return (
          <rect
            key={d.label}
            className={d.value === 0 ? 'chart__bar chart__bar--muted' : 'chart__bar'}
            x={x}
            y={plotH - h}
            width={w}
            height={Math.max(d.value === 0 ? 1 : 2, h)}
          />
        )
      })}
      <line className="chart__axis" x1="0" y1={plotH} x2="100" y2={plotH} vectorEffect="non-scaling-stroke" />
      {data.map((d, i) => (
        <text
          key={d.label}
          className="chart__label"
          x={i * barW + barW / 2}
          y={height - 6}
          textAnchor="middle"
          style={{ fontSize: 7 }}
        >
          {d.label}
        </text>
      ))}
    </svg>
  )
}
