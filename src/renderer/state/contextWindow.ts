import { create } from 'zustand'
import type { ContextWindowUsage } from '@shared/types'

// Claude windows depend on session configuration: rehydrate them through context.ensure,
// never restore a stale denominator. Agent-owned transcript windows may still be persisted
// (notably Grok, which cannot locate its signals file until the next hook after restart).
const KEY = 'nodeterm.contextWindow'
// Hard cap on retained sessions. Every resume / `/clear` / restart mints a new sessionId, so
// without a bound the map would grow forever (and we'd re-stringify the whole thing on every
// hook tick). 200 is far more than any realistic number of live meters; oldest are evicted.
const MAX_SESSIONS = 200
// Don't write localStorage on every update (onUpdate fires repeatedly within a turn); coalesce.
const SAVE_DEBOUNCE_MS = 2000

function load(): Record<string, ContextWindowUsage> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, ContextWindowUsage>
    return data && typeof data === 'object' ? prune(persistable(data)) : {}
  } catch {
    return {}
  }
}

function persistable(map: Record<string, ContextWindowUsage>): Record<string, ContextWindowUsage> {
  // Older records have no provenance; invalidate them instead of guessing their agent.
  return Object.fromEntries(Object.entries(map).filter(([, usage]) =>
    usage?.windowSource === 'transcript' && !usage.nodeId && !usage.cleared))
}

/** Keep only the MAX_SESSIONS most-recently-updated entries (LRU by updatedAt). */
function prune(map: Record<string, ContextWindowUsage>): Record<string, ContextWindowUsage> {
  const keys = Object.keys(map)
  if (keys.length <= MAX_SESSIONS) return map
  const newest = keys
    .sort((a, b) => (map[b]?.updatedAt ?? 0) - (map[a]?.updatedAt ?? 0))
    .slice(0, MAX_SESSIONS)
  const out: Record<string, ContextWindowUsage> = {}
  for (const k of newest) out[k] = map[k]
  return out
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(bySessionId: Record<string, ContextWindowUsage>): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(persistable(bySessionId)))
    } catch {
      // ignore quota / serialization errors
    }
  }, SAVE_DEBOUNCE_MS)
}

interface ContextWindowState {
  bySessionId: Record<string, ContextWindowUsage>
  /** Remote observations are node-owned and never restored from browser storage. */
  byNodeId: Record<string, ContextWindowUsage>
  set(usage: ContextWindowUsage): void
}

export const useContextWindow = create<ContextWindowState>((set) => ({
  bySessionId: load(),
  byNodeId: {},
  set: (usage) =>
    set((s) => {
      if (usage.nodeId) {
        if (usage.cleared) {
          if (s.byNodeId[usage.nodeId]?.sessionId !== usage.sessionId) return s
          const byNodeId = { ...s.byNodeId }
          delete byNodeId[usage.nodeId]
          return { byNodeId }
        }
        return { byNodeId: prune({ ...s.byNodeId, [usage.nodeId]: usage }) }
      }
      if (usage.cleared) return s
      const merged = { ...s.bySessionId, [usage.sessionId]: usage }
      const bySessionId = prune(merged)
      scheduleSave(bySessionId)
      return { bySessionId }
    })
}))
