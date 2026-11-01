import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { AgentNodeStatus, AgentStatusSession } from '../state/agentStatus'
import { agentStatusForProject, sessionRegistryVersion, subscribeSessionRegistry } from './session'

/**
 * A node's agent status, asked PER PROJECT (bug D). The list surfaces — the sessions sidebar, the
 * project-tab unread dot, the boards — show many projects at once, and a node id is not unique
 * across them: a handed-off SSH project (local session, the default store) and the team tab now
 * serving the same canvas (relay session, its own keyless store) hold the SAME ids. So a status is
 * looked up through the store of the session the row's PROJECT belongs to (`agentStatusForProject`),
 * never through one store for every row and never through the active project.
 */
export type AgentStatusLookup = (projectId: string, nodeId: string) => AgentNodeStatus | undefined

type StatusStore = AgentStatusSession['store']

/** An own entry of the table, or nothing. Node ids come from a git-shared, hand-editable project
 *  file, and `byId['constructor']` on a plain object is Object's constructor, not a status. */
function entryOf(byId: Readonly<Record<string, AgentNodeStatus>>, nodeId: string): AgentNodeStatus | undefined {
  return Object.prototype.hasOwnProperty.call(byId, nodeId) ? byId[nodeId] : undefined
}

function storeFor(projectId: string): StatusStore {
  return agentStatusForProject(projectId).store
}

/**
 * The non-hook lookup, for tests and imperative reads (an on-demand queue build, a click handler):
 * each listed project's store is resolved NOW, and every call reads that store's CURRENT table. A
 * project that was not listed is resolved at call time. Subscribes to nothing — a component that
 * renders from it wants `useAgentStatusLookup` / `useAgentStatusSig`.
 */
export function lookupFromStores(projectIds: readonly string[]): AgentStatusLookup {
  const stores = new Map<string, StatusStore>()
  for (const id of projectIds) stores.set(id, storeFor(id))
  return (projectId, nodeId) => entryOf((stores.get(projectId) ?? storeFor(projectId)).getState().byId, nodeId)
}

/** A lookup over a FROZEN set of tables (one per listed project) — the hook's snapshot, so a
 *  render reads one consistent state. Unlisted ids fall back to a live read, like `lookupFromStores`. */
function lookupFromTables(tables: ReadonlyMap<string, Readonly<Record<string, AgentNodeStatus>>>): AgentStatusLookup {
  return (projectId, nodeId) => {
    const byId = tables.get(projectId) ?? storeFor(projectId).getState().byId
    return entryOf(byId, nodeId)
  }
}

/** A stable small number per store object, so the set of resolved stores can key a callback. */
const storeIds = new WeakMap<StatusStore, number>()
let nextStoreId = 0
function storeId(store: StatusStore): number {
  let id = storeIds.get(store)
  if (id === undefined) {
    id = ++nextStoreId
    storeIds.set(store, id)
  }
  return id
}

interface Snapshot {
  key: readonly unknown[]
  lookup: AgentStatusLookup
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The shared source behind both hooks: one subscription to every DISTINCT store the listed
 * projects resolve to plus the session registry signal, and a snapshot lookup memoized on the
 * tuple (project ids, registry version, each project's `byId` reference).
 *
 * Re-resolution: a registry change (a reconnect swaps a project's session, an unbind sends it to
 * the offline session) notifies the subscriber; the snapshot re-resolves and changes, the caller
 * re-renders, the render resolves the NEW store set, and its changed key re-subscribes. A
 * resolution that moves only because the projects store changed (`remote` read by
 * `agentStatusForProject`) is picked up the same way on the caller's next render — every caller
 * holds the projects it passes, so it re-renders on them.
 */
function useLookupSource(projectIds: readonly string[]): {
  subscribe: (onChange: () => void) => () => void
  getLookup: () => AgentStatusLookup
} {
  const distinct = [...new Set(projectIds.map(storeFor))]
  const storesKey = distinct.map(storeId).join(',')
  // The callback closes over THIS render's distinct stores; its identity changes exactly when the
  // set does, which is what makes React re-subscribe.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offs = distinct.map((store) => store.subscribe(onChange))
      offs.push(subscribeSessionRegistry(onChange))
      return () => {
        for (const off of offs) off()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storesKey]
  )
  const idsRef = useRef(projectIds)
  idsRef.current = projectIds
  const cache = useRef<Snapshot | null>(null)
  const getLookup = useCallback((): AgentStatusLookup => {
    const ids = idsRef.current
    const tables = ids.map((id) => storeFor(id).getState().byId)
    const key: unknown[] = [JSON.stringify(ids), sessionRegistryVersion(), ...tables]
    if (cache.current && sameKey(cache.current.key, key)) return cache.current.lookup
    const lookup = lookupFromTables(new Map(ids.map((id, i) => [id, tables[i]])))
    cache.current = { key, lookup }
    return lookup
  }, [])
  return { subscribe, getLookup }
}

/** Re-renders when a resolved store's byId changes or a project's resolution changes. */
export function useAgentStatusLookup(projectIds: readonly string[]): AgentStatusLookup {
  const { subscribe, getLookup } = useLookupSource(projectIds)
  return useSyncExternalStore(subscribe, getLookup)
}

/**
 * Primitive-signature form: re-renders only when `sig(lookup)` changes. The list surfaces' rule
 * (`unreadIdsSig`, `statusChipSig`): a hook event elsewhere on the canvas changes `byId` but not
 * the fact this caller shows, and must re-render nothing here.
 */
export function useAgentStatusSig(
  projectIds: readonly string[],
  sig: (lookup: AgentStatusLookup) => string
): string {
  const { subscribe, getLookup } = useLookupSource(projectIds)
  const last = useRef<{ lookup: AgentStatusLookup; sig: (lookup: AgentStatusLookup) => string; value: string } | null>(
    null
  )
  const getSig = (): string => {
    const lookup = getLookup()
    if (last.current && last.current.lookup === lookup && last.current.sig === sig) return last.current.value
    const value = sig(lookup)
    last.current = { lookup, sig, value }
    return value
  }
  return useSyncExternalStore(subscribe, getSig)
}
