// Exit an agent CLI by node id, with no mounted terminal: the bulk "Pause all" drives the same pure
// `performExitPhase` the node menu and Eco use, against core primitives (pane keys by id, pane
// command, pane owner) instead of a node's DeliveryIo. Shallow only: the tmux pane and its
// scrollback stay; nothing here recycles a session.
import type { DeliveryIo } from '@shared/command-delivery'
import type { PaneKeysResult } from '@shared/types'
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'
import type { AgentNodeStatus } from '../state/agentStatus'
import { isBusyForPause, type BulkPauseTarget } from '../lib/bulkPause'
import { performExitPhase, guardConcurrentRestart, RESTART_EXIT_TIMEOUT_MS } from './agent-restart'
import { decideHibernateExit, captureWakeContext, type WakeContext } from './wake-identity'

export const BULK_PAUSE_HOST_CAP = 3

export type HeadlessPauseOutcome = 'paused' | 'exit-timeout' | 'not-eligible' | 'deferred' | 'unreachable'

export interface HeadlessPauseDeps {
  sendPaneKeys(nodeId: string, data: string): Promise<PaneKeysResult>
  paneCommand(nodeId: string): Promise<string | null>
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  status(nodeId: string): AgentNodeStatus | undefined
  binaries(agentId: string): readonly string[] | null
  stillExists(nodeId: string): boolean
  markPaused(nodeId: string, ctx: { alreadyExited: boolean; wake: WakeContext | null }): void
}

/** Bounded, never-rejecting pane-owner read (mirrors TerminalNode's readPaneOwner): a hang or a
 *  rejection reads as "could not see the pane" (null), and the timer is always cleared. */
async function readOwnerSafe(
  nodeId: string, deps: HeadlessPauseDeps, ms: number
): Promise<PaneOwner | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      deps.paneOwner(nodeId).catch(() => null),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), ms) })
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A DeliveryIo whose writes go into the pane by node id, in order. `onData` is never used by the
 *  exit phase (it polls the pane command instead). The first failed write is remembered. */
function paneKeysIo(nodeId: string, deps: HeadlessPauseDeps): { io: DeliveryIo; failed: () => Promise<boolean> } {
  let chain: Promise<unknown> = Promise.resolve()
  let failed = false
  const io: DeliveryIo = {
    write: (d) => {
      chain = chain.then(async () => {
        if (failed) return
        try {
          const r = await deps.sendPaneKeys(nodeId, d)
          if (!r.ok) failed = true
        } catch {
          failed = true
        }
      })
    },
    onData: () => () => {}
  }
  return { io, failed: async () => { await chain; return failed } }
}

export function pauseNodeHeadless(
  target: BulkPauseTarget,
  alreadyExited: boolean,
  deps: HeadlessPauseDeps,
  timing?: { pollMs?: number; timeoutMs?: number; ownerTimeoutMs?: number }
): Promise<HeadlessPauseOutcome> {
  return guardConcurrentRestart(target.nodeId, async (): Promise<HeadlessPauseOutcome> => {
    const { nodeId, agentId } = target
    const { ownerTimeoutMs = RESTART_EXIT_TIMEOUT_MS, ...exitTiming } = timing ?? {}
    const st = deps.status(nodeId)
    if (!agentId || !st?.sessionId || st.paused || st.sessionEnded || !deps.stillExists(nodeId)) {
      return 'not-eligible'
    }
    if (alreadyExited || st.hibernated) {
      deps.markPaused(nodeId, { alreadyExited: true, wake: null })
      return 'paused'
    }
    if (isBusyForPause(st)) return 'deferred' // fire-time re-ask: the plan-time verdict is stale
    const owner = await readOwnerSafe(nodeId, deps, ownerTimeoutMs)
    if (decideHibernateExit(owner, agentId, deps.binaries(agentId)) !== 'agent-owns-pane') return 'not-eligible'
    if (isBusyForPause(deps.status(nodeId))) return 'deferred'
    const keys = paneKeysIo(nodeId, deps)
    const outcome = await performExitPhase({
      agentId,
      sessionId: st.sessionId,
      io: keys.io,
      paneCommand: () => deps.paneCommand(nodeId),
      isLive: () => deps.stillExists(nodeId),
      ...exitTiming
    })
    // A failed key write usually surfaces as an exit timeout; report it as unreachable so the
    // summary does not claim "still running" for a node we never reached.
    if (await keys.failed()) return 'unreachable'
    if (outcome !== 'exited') return outcome === 'exit-timeout' ? 'exit-timeout' : 'not-eligible'
    deps.markPaused(nodeId, { alreadyExited: false, wake: captureWakeContext(await readOwnerSafe(nodeId, deps, ownerTimeoutMs)) })
    return 'paused'
  })()
}

export interface HostLimiter {
  run<T>(hostKey: string, fn: () => Promise<T>): Promise<T>
}

/**
 * At most `cap` jobs in flight per host key, the rest queued FIFO. ONE instance must be shared by
 * every caller that exits CLIs on a host — the batch AND the pending-pause watcher — or each
 * caller gets its own cap and together they exceed it. A throwing `fn` rejects only its own
 * promise and frees its slot.
 */
export function createHostLimiter(cap: number): HostLimiter {
  const inFlight = new Map<string, number>()
  const queues = new Map<string, (() => void)[]>()
  const release = (key: string): void => {
    const next = queues.get(key)?.shift()
    if (next) {
      next() // the slot passes straight to the next waiter
      return
    }
    queues.delete(key)
    const n = (inFlight.get(key) ?? 1) - 1
    if (n > 0) inFlight.set(key, n)
    else inFlight.delete(key)
  }
  const acquire = (key: string): Promise<void> => {
    const n = inFlight.get(key) ?? 0
    if (n < cap) {
      inFlight.set(key, n + 1)
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const q = queues.get(key) ?? []
      q.push(resolve)
      queues.set(key, q)
    })
  }
  return {
    async run<T>(hostKey: string, fn: () => Promise<T>): Promise<T> {
      await acquire(hostKey)
      try {
        return await fn()
      } finally {
        release(hostKey)
      }
    }
  }
}

/** Every item through a fresh limiter; per-item failures are contained (the caller's `run` owns
 *  reporting its own). */
export async function runWithHostCap<T>(
  items: T[],
  hostKey: (t: T) => string,
  cap: number,
  run: (t: T) => Promise<void>,
  limiter: HostLimiter = createHostLimiter(cap)
): Promise<void> {
  await Promise.all(items.map((it) => limiter.run(hostKey(it), () => run(it)).catch(() => {})))
}
