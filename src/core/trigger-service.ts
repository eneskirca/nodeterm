/**
 * The trigger node's whole host-side machine, composed ONCE (issue #493, phase 3): the
 * machine-local arm store + the scheduler + the delivery (with its deliver-on-idle queue) + the
 * idle signal, wired together here so BOTH shells boot the identical thing with a one-call
 * `startTriggerService(...)`. This is the duplicated-wiring lesson applied preemptively — phase 2
 * had each shell assemble the pieces inline, and every extra piece phase 3 adds is one more line
 * for the two copies to disagree about.
 *
 * The idle signal is the core mirror's own `done` edge (`onNodeStateChange`), which both shells
 * already feed through their raw hook listeners — so the queue flush needs NO per-shell listener
 * branch, and there is nothing here for the hook-parity discipline to chase.
 */

import { IPC } from '../shared/ipc'
import { isSafeNodeId } from '../shared/safe-id'
import { mirrorEntry, onNodeStateChange } from './agent-status-mirror'
import { TriggerArmStore } from './trigger-arm-store'
import { createTriggerDelivery, type TriggerDeliveryDeps } from './trigger-delivery'
import {
  createTriggerScheduler,
  triggerRowsFromCanvases,
  type TriggerScheduler
} from './trigger-scheduler'
import {
  computeNextFire,
} from './trigger-scheduler'
import {
  sanitizeTriggerSpec,
  type TriggerNodeStatus,
  type TriggerSpec
} from '../shared/trigger'
import type { CanvasNodeState } from '../shared/types'

export interface TriggerServiceDeps {
  /** Where the arm store persists (`app.getPath('userData')` / `config.dataDir`). */
  userDataDir: string
  /** `WorkspaceStore.persistedCanvases` — the trigger list's raw material. */
  listCanvases(): Array<{ id: string; nodes: CanvasNodeState[] }>
  /** `WorkspaceStore.getNode` — target resolution + the flush-time current-spec re-read. */
  getNode(nodeId: string): CanvasNodeState | undefined
  /** `PtyManager.sendText` / `PtyManager.paneCommand`. */
  sendText(nodeId: string, text: string): Promise<boolean>
  paneCommand(nodeId: string): Promise<string | null>
  /**
   * Register one request/response IPC handler — both shells pass `platform().handle`. REQUIRED
   * (not defaulted inside core) so a shell that forgets it is a compile error rather than a
   * surface that silently has no arm/disarm; tests pass a recorder.
   */
  handle(channel: string, handler: (...args: unknown[]) => unknown): void
  /** Test seams; production passes none. */
  now?(): number
  schedulerIntervalMs?: number
  schedule?: TriggerDeliveryDeps['schedule']
}

export interface TriggerService {
  scheduler: TriggerScheduler
  armStore: TriggerArmStore
  stop(): void
}

export function startTriggerService(deps: TriggerServiceDeps): TriggerService {
  const armStore = new TriggerArmStore(deps.userDataDir)
  const isArmed = (projectId: string, nodeId: string, spec: Parameters<TriggerArmStore['isArmed']>[2]) =>
    armStore.isArmed(projectId, nodeId, spec)

  const delivery = createTriggerDelivery({
    sendText: deps.sendText,
    paneCommand: deps.paneCommand,
    agentState: (nodeId) => mirrorEntry(nodeId),
    targetNode: (nodeId) => deps.getNode(nodeId),
    // The trigger's OWN node, freshly resolved — what the queue's flush re-validates against.
    // getNode scans by node id; the projectId key is already bound into the arm record.
    currentSpec: (_projectId, nodeId) => {
      const node = deps.getNode(nodeId)
      if (!node || node.kind !== 'trigger') return undefined
      return sanitizeTriggerSpec(node.trigger)
    },
    isArmed,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {})
  })

  const scheduler = createTriggerScheduler({
    listTriggers: () => triggerRowsFromCanvases(deps.listCanvases()),
    isArmed,
    fire: (row) => delivery.fire(row),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedulerIntervalMs ? { intervalMs: deps.schedulerIntervalMs } : {})
  })
  delivery.setRunSink(scheduler.recordExternalRun)

  // The queue's flush trigger: a target finished a turn, so it is idle NOW — the same edge
  // messaging flushes on, read from core instead of each shell's listener.
  const unsubscribe = onNodeStateChange((change) => {
    if (change.state === 'done') void delivery.onTargetIdle(change.nodeId)
  })

  // ── The card's IPC surface (issue #493, phase 4) ────────────────────────────────────────────
  // Everything here re-validates its inputs at this boundary (the values crossed a process/WS
  // boundary), and `run-now` deliberately takes NO spec from the caller: the payload that runs is
  // always the node's CURRENT persisted content, resolved core-side — a caller can choose WHEN,
  // never WHAT. `arm` DOES take the spec: consent must bind to the exact content the user was
  // shown, and the renderer's live copy can be ahead of the debounced save; `TriggerArmStore.arm`
  // re-sanitizes and canonicalizes it, so a binding for content that never lands simply reads as
  // disarmed. The keys are checked with the same predicate the store uses.
  const safeKeys = (projectId: unknown, nodeId: unknown): projectId is string =>
    typeof projectId === 'string' && typeof nodeId === 'string' &&
    isSafeNodeId(projectId) && isSafeNodeId(nodeId)

  const currentSpecOf = (nodeId: string): TriggerSpec | undefined => {
    const node = deps.getNode(nodeId)
    if (!node || node.kind !== 'trigger') return undefined
    return sanitizeTriggerSpec(node.trigger)
  }

  deps.handle(IPC.triggersArm, async (payload) => {
    const p = (payload ?? {}) as { projectId?: unknown; nodeId?: unknown; spec?: unknown }
    if (!safeKeys(p.projectId, p.nodeId)) return false
    const spec = sanitizeTriggerSpec(p.spec)
    if (!spec) return false
    return armStore.arm(p.projectId as string, p.nodeId as string, spec)
  })

  deps.handle(IPC.triggersDisarm, async (payload) => {
    const p = (payload ?? {}) as { projectId?: unknown; nodeId?: unknown }
    if (!safeKeys(p.projectId, p.nodeId)) return
    await armStore.disarm(p.projectId as string, p.nodeId as string)
  })

  deps.handle(IPC.triggersStatus, async (payload): Promise<TriggerNodeStatus> => {
    const p = (payload ?? {}) as { projectId?: unknown; nodeId?: unknown }
    const empty: TriggerNodeStatus = {
      armed: false, armedForOtherContent: false, nextFireAt: null, runs: []
    }
    if (!safeKeys(p.projectId, p.nodeId)) return empty
    const projectId = p.projectId as string
    const nodeId = p.nodeId as string
    const spec = currentSpecOf(nodeId)
    const armed = spec ? armStore.isArmed(projectId, nodeId, spec) : false
    const record = armStore.armedRecord(projectId, nodeId)
    // The scheduler's own nextFireAt is the sweep's anchored value; a fresh/edited trigger the
    // sweep has not seen yet still deserves a countdown, so fall back to a pure computation.
    const scheduled = scheduler.nextFireAt(projectId, nodeId)
    const nextFireAt =
      scheduled ?? (spec ? computeNextFire(spec, (deps.now ?? Date.now)()) : null)
    return {
      armed,
      armedForOtherContent: !armed && !!record,
      nextFireAt,
      runs: scheduler.runsFor(projectId, nodeId)
    }
  })

  deps.handle(IPC.triggersRunNow, async (payload) => {
    const p = (payload ?? {}) as { projectId?: unknown; nodeId?: unknown }
    if (!safeKeys(p.projectId, p.nodeId))
      return { outcome: 'failed', detail: 'invalid trigger reference' }
    const projectId = p.projectId as string
    const nodeId = p.nodeId as string
    const spec = currentSpecOf(nodeId)
    if (!spec) return { outcome: 'failed', detail: 'the trigger has no valid definition' }
    // An explicit user click, delivered through the SAME gates as a scheduled fire (idle gate,
    // queue, missed-when-dead) — the only thing bypassed is the schedule. Recorded in the same
    // ring so the card shows one history.
    const result = await delivery.fire({ projectId, nodeId, spec })
    scheduler.recordExternalRun(projectId, nodeId, {
      at: (deps.now ?? Date.now)(),
      outcome: result.outcome,
      ...(result.detail ? { detail: result.detail } : {})
    })
    return result
  })

  void armStore.load().finally(() => scheduler.start())

  return {
    scheduler,
    armStore,
    stop() {
      unsubscribe()
      scheduler.stop()
    }
  }
}
