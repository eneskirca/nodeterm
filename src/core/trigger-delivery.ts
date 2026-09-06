/**
 * Trigger DELIVERY (issue #493, phase 3) — the real implementation behind the scheduler's `fire`
 * seam: put the armed payload into the target's pane, or say honestly why not.
 *
 * The delivery path is the existing `sendText` (`paste-buffer -p` — tmux frames from the pane's
 * REAL bracketed-paste state, and the payload travels by stdin, never argv). This module only
 * decides WHETHER to send, and the rules mirror the ones agent messaging already measured:
 *
 *  - **An agent target delivers only on a verified-idle turn boundary** (`mirrorEntry.state ===
 *    'done'`). A `working` target is mid-turn; a `blocked`/`waiting` one is sitting on a
 *    permission prompt or a question, where a pasted payload would ANSWER it (the agent-restart
 *    lesson). An UNKNOWN state — no hook event this app run, common right after a restart — is
 *    not evidence of idleness either. All of those go to the deliver-on-idle QUEUE.
 *  - **The queue is the messaging `DeliveryQueue`, own instance** — same TTL/capacity/flush
 *    machinery, same load-bearing property: the flush re-runs the WHOLE decision against live
 *    state (arm gate included), caching nothing. A trigger disarmed — or spec-edited — while its
 *    payload waited is DROPPED at flush, never delivered; pinned by test. The idle signal is the
 *    core mirror's own `done` edge (`onNodeStateChange`), which BOTH shells feed, so there is no
 *    per-shell listener to drift.
 *  - **A plain-terminal target delivers only into a SHELL-owned pane** (`isShellCommand`) — the
 *    payload executing is the trigger's purpose, consented at arm time — and is never queued: the
 *    DECSET-2004 measurement behind the queue says a non-agent pane is the ONE unsafe surface for
 *    an unattended paste, and a plain terminal emits no idle event to flush on anyway. A pane
 *    running something else (vim, a dev server) is an honest `missed`, with the command named.
 *  - **A dead target is a `missed`, never a cold start** (v1 decision from the design thread):
 *    a session that does not exist (`sendText` → false, `paneCommand` → null) records why and the
 *    schedule moves on. Auto-launching a node from a timer is a larger consent surface, deferred.
 */

import { randomUUID } from 'node:crypto'
import { hasHooks, type AgentId } from '../shared/agents/config'
import { isShellCommand } from '../shared/agents/pane'
import { canonicalTriggerSpec, sanitizeTriggerSpec, type TriggerSpec } from '../shared/trigger'
import type { AgentMessageOutcome } from './agents/agent-message-decide'
import { DeliveryQueue, type CancelTimer, type QueuedDeliveryRequest } from './agents/delivery-queue'
import type { TriggerFireResult, TriggerRow, TriggerRun } from './trigger-scheduler'

export interface TriggerDeliveryDeps {
  /** `PtyManager.sendText` — the paste path; false = tmux unavailable / session doesn't exist. */
  sendText(nodeId: string, text: string): Promise<boolean>
  /** `PtyManager.paneCommand` — null = no live session / unreadable, never evidence of a command. */
  paneCommand(nodeId: string): Promise<string | null>
  /** The mirror's live view of the target (`mirrorEntry`) — state undefined = unknown. */
  agentState(nodeId: string): { state?: string } | undefined
  /** The persisted target node (`WorkspaceStore.getNode`) — undefined = gone from every canvas. */
  targetNode(nodeId: string): { agentId?: string } | undefined
  /**
   * The TRIGGER node's own current spec, re-resolved for the flush-time re-validation — never the
   * queued copy. Undefined = the trigger node (or its spec) is gone.
   */
  currentSpec(projectId: string, nodeId: string): TriggerSpec | undefined
  /** The machine-local, content-bound arm gate — re-asked at flush exactly as at fire. */
  isArmed(projectId: string, nodeId: string, spec: TriggerSpec): boolean
  now?(): number
  /** Timer seam for the queue's TTL (tests); defaults to setTimeout. */
  schedule?(ms: number, fn: () => void): CancelTimer
}

/** What one attempt decided. `queue` is only ever produced for an agent target (see module doc). */
type Attempt =
  | { act: 'fired' }
  | { act: 'missed'; detail: string }
  | { act: 'queue'; reason: string }

export interface TriggerDelivery {
  /** The scheduler's `fire` dep. */
  fire(row: TriggerRow): Promise<TriggerFireResult>
  /** Flush the target's queued payloads — wired to the mirror's `done` edges by the service. */
  onTargetIdle(nodeId: string): Promise<void>
  /** Where the queue's LATE outcomes land (`scheduler.recordExternalRun`); set once at boot. */
  setRunSink(sink: (projectId: string, nodeId: string, run: TriggerRun) => void): void
}

export function createTriggerDelivery(deps: TriggerDeliveryDeps): TriggerDelivery {
  const now = deps.now ?? Date.now
  let sink: ((projectId: string, nodeId: string, run: TriggerRun) => void) | undefined

  const attempt = async (row: TriggerRow): Promise<Attempt> => {
    const node = deps.targetNode(row.spec.target)
    if (!node) return { act: 'missed', detail: 'target node no longer exists' }
    if (node.agentId && hasHooks(node.agentId as AgentId)) {
      const state = deps.agentState(row.spec.target)?.state
      if (state !== 'done') {
        // Unknown is not idle: right after an app restart an agent sitting at its prompt has no
        // live state, and pasting into what MIGHT be a permission prompt is the failure this
        // gate exists for. The queue waits for the next real `done` edge instead.
        return {
          act: 'queue',
          reason: state ? `target is ${state}` : 'no live agent state for the target yet'
        }
      }
    } else {
      const pane = await deps.paneCommand(row.spec.target)
      if (pane === null)
        return { act: 'missed', detail: 'target session is not running (or its pane is unreadable)' }
      if (!isShellCommand(pane))
        // Never queued: a non-agent pane is the one surface the deliver-on-idle measurement
        // calls unsafe for an unattended paste, and nothing would ever flush it anyway.
        return { act: 'missed', detail: `target pane is running '${pane}' — refusing to type into it` }
    }
    const sent = await deps.sendText(row.spec.target, row.spec.payload)
    return sent ? { act: 'fired' } : { act: 'missed', detail: 'target session is not running' }
  }

  /**
   * The queue's `deliver` — the FULL re-validated attempt, expressed in the messaging outcome
   * vocabulary the queue's requeue set understands. Only the `kind` matters to the queue
   * (REQUEUE_ON membership → wait for the next idle; anything else is terminal); the run the
   * user sees is derived in `onFlushed` below, so no messaging trace/receipt semantics leak in.
   */
  const flushDeliver = async (req: QueuedDeliveryRequest): Promise<AgentMessageOutcome> => {
    const projectId = req.projectId as string
    const triggerNodeId = req.sourceNodeId
    // Flush-time re-validation, against live state and never the queued copy: the trigger must
    // still exist, still carry the SAME content it was queued for, and still be armed for it.
    const current = deps.currentSpec(projectId, triggerNodeId)
    const safe = current && sanitizeTriggerSpec(current)
    if (!safe || canonicalTriggerSpec(safe) !== (req.canon as string))
      return { kind: 'notPermitted', reason: 'switch-off' } // terminal: spec gone or edited while queued
    if (!deps.isArmed(projectId, triggerNodeId, safe))
      return { kind: 'notPermitted', reason: 'switch-off' } // terminal: disarmed while queued
    const a = await attempt({ projectId, nodeId: triggerNodeId, spec: safe })
    if (a.act === 'fired')
      // The extra fields are the messaging receipt contract; the queue never reads them, and the
      // run recorded for the card comes from `onFlushed`, keyed on the kind alone.
      return { kind: 'delivered', traceId: randomUUID(), traced: 'memory', receipt: 'observed', signal: 'newTurn' }
    if (a.act === 'queue') return { kind: 'targetBusy', state: a.reason } // requeued, TTL keeps counting
    return { kind: 'targetGone' } // terminal miss — the target left while the payload waited
  }

  const queue = new DeliveryQueue({
    now,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    deliver: flushDeliver,
    // Trigger runs are recorded in the trigger's own run ring (below), not the board log — a
    // scheduled fire is not an agent-to-agent message. The queue only needs an id back.
    trace: async () => ({ traceId: randomUUID(), traced: 'memory' as const }),
    onFlushed: (req, outcome) => {
      const run: TriggerRun =
        outcome.kind === 'delivered'
          ? { at: now(), outcome: 'delivered-late' }
          : outcome.kind === 'notPermitted'
            ? { at: now(), outcome: 'missed', detail: 'disarmed or edited while queued — dropped' }
            : { at: now(), outcome: 'missed', detail: 'target went away while queued' }
      sink?.(req.projectId as string, req.sourceNodeId, run)
    },
    onExpired: (req, info) => {
      sink?.(req.projectId as string, req.sourceNodeId, {
        at: now(),
        outcome: 'expired',
        detail: `target never went idle (queued ${Math.round(info.queuedForMs / 1000)}s)`
      })
    }
  })

  return {
    async fire(row) {
      const a = await attempt(row)
      if (a.act === 'fired') return { outcome: 'fired' }
      if (a.act === 'missed') return { outcome: 'missed', detail: a.detail }
      const queued = await queue.enqueue({
        sourceNodeId: row.nodeId,
        targetNodeId: row.spec.target,
        sourceTitle: 'trigger',
        body: row.spec.payload,
        projectId: row.projectId,
        // The content binding rides the queue entry so the flush can tell "same trigger, edited
        // spec" from "the spec I was queued for".
        canon: canonicalTriggerSpec(row.spec)
      })
      if (queued.kind === 'queueFull')
        return { outcome: 'failed', detail: `deliver-on-idle queue is full (${queued.capacity})` }
      return {
        outcome: 'queued',
        detail: `${a.reason} — will deliver when it goes idle (waits up to ${Math.round(queued.ttlMs / 60_000)} min)`
      }
    },
    onTargetIdle: (nodeId) => queue.onTargetIdle(nodeId),
    setRunSink(s) {
      sink = s
    }
  }
}
