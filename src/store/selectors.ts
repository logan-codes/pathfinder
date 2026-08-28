/**
 * Derived-state hooks.
 *
 * These must NOT live as methods called inside a zustand selector: a
 * selector that computes a fresh object on every call fails the store's
 * snapshot identity check and re-renders forever. Instead each hook
 * selects stable slices and memoises the derivation.
 */

import { useMemo } from 'react'
import { RESOURCE_BY_ID } from '@/lib/catalog'
import { pathResourceIds, profileSkills } from '@/lib/engine'
import type { ItemStatus, Level, ResourceId, SkillId } from '@/lib/types'
import { useAppStore } from './useAppStore'

export interface Progress {
  done: number
  total: number
  hoursDone: number
  hoursTotal: number
}

export function useSkillLevels(): Record<SkillId, Level> {
  const profile = useAppStore((s) => s.profile)
  return useMemo(() => profileSkills(profile), [profile])
}

export function useOrderedResourceIds(): ResourceId[] {
  const path = useAppStore((s) => s.path)
  return useMemo(() => pathResourceIds(path), [path])
}

export function useProgress(): Progress {
  const path = useAppStore((s) => s.path)
  const status = useAppStore((s) => s.status)

  return useMemo(() => {
    const ids = pathResourceIds(path)
    const doneIds = ids.filter((id) => status[id] === 'done')
    const hoursOf = (id: ResourceId) => RESOURCE_BY_ID[id]?.hours ?? 0
    return {
      done: doneIds.length,
      total: ids.length,
      hoursDone: doneIds.reduce((sum, id) => sum + hoursOf(id), 0),
      hoursTotal: ids.reduce((sum, id) => sum + hoursOf(id), 0),
    }
  }, [path, status])
}

/** First item in path order that is not yet done. */
export function useNextUp(): ResourceId | null {
  const path = useAppStore((s) => s.path)
  const status = useAppStore((s) => s.status)

  return useMemo(() => {
    const ids = pathResourceIds(path)
    return ids.find((id) => status[id] !== 'done') ?? null
  }, [path, status])
}

/** Path items still outstanding, in order, tagged with their milestone. */
export function useQueue(limit = 4): Array<{ resourceId: ResourceId; milestone: string }> {
  const path = useAppStore((s) => s.path)
  const status = useAppStore((s) => s.status)

  return useMemo(() => {
    if (!path) return []
    return path.milestones
      .flatMap((m) => m.items.map((i) => ({ resourceId: i.resourceId, milestone: m.title })))
      .filter((i) => status[i.resourceId] !== 'done')
      .slice(0, limit)
  }, [path, status, limit])
}

/** Completed path items, most recent first. */
export function useRecentlyCompleted(limit = 4): ResourceId[] {
  const path = useAppStore((s) => s.path)
  const status = useAppStore((s) => s.status)

  return useMemo(() => {
    if (!path) return []
    return path.milestones
      .flatMap((m) => m.items.map((i) => i.resourceId))
      .filter((id) => status[id] === 'done')
      .slice(-limit)
      .reverse()
  }, [path, status, limit])
}

export type { ItemStatus }
