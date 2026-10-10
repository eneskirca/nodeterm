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

function withinTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
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
  timing?: { pollMs?: number; timeoutMs?: number }
): Promise<HeadlessPauseOutcome> {
  return guardConcurrentRestart(target.nodeId, async (): Promise<HeadlessPauseOutcome> => {
    const { nodeId, agentId } = target
    const st = deps.status(nodeId)
    if (!agentId || !st?.sessionId || st.paused || st.sessionEnded || !deps.stillExists(nodeId)) {
      return 'not-eligible'
    }
    if (alreadyExited || st.hibernated) {
      deps.markPaused(nodeId, { alreadyExited: true, wake: null })
      return 'paused'
    }
    if (isBusyForPause(st)) return 'deferred' // fire-time re-ask: the plan-time verdict is stale
    const owner = await withinTimeout(deps.paneOwner(nodeId), RESTART_EXIT_TIMEOUT_MS)
    if (decideHibernateExit(owner, agentId, deps.binaries(agentId)) !== 'agent-owns-pane') return 'not-eligible'
    if (isBusyForPause(deps.status(nodeId))) return 'deferred'
    const keys = paneKeysIo(nodeId, deps)
    const outcome = await performExitPhase({
      agentId,
      sessionId: st.sessionId,
      io: keys.io,
      paneCommand: () => deps.paneCommand(nodeId),
      isLive: () => deps.stillExists(nodeId),
      ...timing
    })
    // A failed key write usually surfaces as an exit timeout; report it as unreachable so the
    // summary does not claim "still running" for a node we never reached.
    if (await keys.failed()) return 'unreachable'
    if (outcome !== 'exited') return outcome === 'exit-timeout' ? 'exit-timeout' : 'not-eligible'
    deps.markPaused(nodeId, { alreadyExited: false, wake: captureWakeContext(await deps.paneOwner(nodeId)) })
    return 'paused'
  })()
}

export async function runWithHostCap<T>(
  items: T[],
  hostKey: (t: T) => string,
  cap: number,
  run: (t: T) => Promise<void>
): Promise<void> {
  const queues = new Map<string, T[]>()
  for (const it of items) {
    const k = hostKey(it)
    queues.set(k, [...(queues.get(k) ?? []), it])
  }
  await Promise.all(
    [...queues.values()].map(async (q) => {
      const workers = Array.from({ length: Math.min(cap, q.length) }, async () => {
        for (let next = q.shift(); next !== undefined; next = q.shift()) await run(next)
      })
      await Promise.all(workers)
    })
  )
}
