import { randomUUID } from 'crypto'
import type { BoardLogEntry } from '../../shared/types'
import type { AgentMessageOutcomeKind, ReceiptSignal, TraceKind } from './agent-message-decide'

/**
 * EVERY DELIVERY AND EVERY REFUSAL LEAVES A TRACE — and the trace records the OUTCOME, not the
 * attempt.
 *
 * A trace that says "a message was sent" and cannot say whether it landed answers the only question
 * anyone ever asks it with silence. So the entry is written after the outcome is known, and carries
 * the outcome kind.
 *
 * The REFUSALS are traced too, and they are the ones an audit actually wants: an agent hammering a
 * target it may not reach, a rate limiter firing over and over, a pane that keeps reading as a
 * stranger's shell. `deliverAgentMessage` routes every pre-write refusal through here for exactly
 * that reason — a security core whose refusals are silent is a security core with no evidence.
 *
 * ── WHY THERE ARE TWO PLACES IT CAN LAND ────────────────────────────────────────────────────────
 *
 * The board log is `<cwd>/.nodeterm/board-log.jsonl`, so a cwd-less inline project, a disconnected
 * SSH project, and any SSH project on the Server Edition have NONE (`board-log-handlers.ts` answers
 * `unsupported` for exactly those three). Refusing to deliver there would make messaging
 * unavailable on precisely the inline canvases orchestration is most used on, so delivery is NOT
 * refused: the entry goes into a bounded in-memory ring instead, and the reply says
 * `traced: 'memory'`.
 *
 * The sender is therefore never told a durable trace exists when it does not. That distinction is
 * the whole reason `traced` is on the wire rather than implied.
 *
 * Neither `nodeterm:toast` (a GLOBAL banner, consumed only for clipboard errors) nor the node-scoped
 * copy pill (explicit "one pill, one owner" contract) is a delivery-trace mechanism. They were
 * considered and rejected; this module is what replaced them.
 */

/** How many deliveries the in-memory ring keeps. Bounded because it is a process-lifetime
 *  singleton: an orchestration session can deliver for hours, and an unbounded array in the main
 *  process is a leak with a nice name. */
export const TRACE_RING_CAPACITY = 200

export interface DeliveryTraceEntry {
  traceId: string
  ts: number
  sourceNodeId: string
  targetNodeId: string
  /** The OUTCOME, not the attempt. */
  outcome: AgentMessageOutcomeKind
  /** Which signal satisfied the receipt, when one did. */
  receipt?: ReceiptSignal
  /** Body size only — the body itself is never traced. A trace that copies the message would put
   *  one agent's payload into another project's on-disk history, where nothing expires it. */
  bodyChars: number
  /** Where the durable copy went. `memory` means there is no durable copy. */
  traced: TraceKind
}

/** Everything `recordDelivery` needs that is not a pure value. Injected, so the ring and the board
 *  log can both be exercised without a filesystem. */
export interface TraceDeps {
  /** Append to the project's board log. `false` = no reachable log (or the write failed) ⇒ ring
   *  only. Wired by the shell to `BoardLogStore.append` / the boardLogAppend handler. */
  appendBoardLog(entry: BoardLogEntry): Promise<boolean>
  now(): number
  /** Overridable so a test can pin the id. */
  traceId?(): string
}

export interface DeliveryTraceInput {
  sourceNodeId: string
  sourceTitle: string
  targetNodeId: string
  outcome: AgentMessageOutcomeKind
  receipt?: ReceiptSignal
  bodyChars: number
  /** The `notPermitted` reason, when that is the outcome. Written to the board-log line so a reader
   *  of the durable history (a board comment's row after a reload) can say WHY, not only THAT. */
  reason?: string
}

const ring: DeliveryTraceEntry[] = []

/** The author stamped on a board-log line. A delivery is the app's own action, not a person's. */
const TRACE_AUTHOR = { name: 'nodeterm', color: '#8b8b8b' } as const

/**
 * Record one delivery. Never throws and never refuses: a trace failure must not fail a delivery
 * that has already put bytes into somebody's pane.
 *
 * The ring is written ALWAYS, board log or not, because it is what Settings → Agents reads (Task
 * 6.3) and a durable line in one project's file is not a live view of this process's deliveries.
 * `traced` reports only whether a DURABLE copy exists.
 */
export async function recordDelivery(
  input: DeliveryTraceInput,
  deps: TraceDeps
): Promise<{ traceId: string; traced: TraceKind }> {
  const traceId = (deps.traceId ?? randomUUID)()
  const ts = deps.now()
  let traced: TraceKind = 'memory'
  try {
    const ok = await deps.appendBoardLog({
      id: traceId,
      ts,
      author: TRACE_AUTHOR,
      nodeId: input.targetNodeId,
      kind: 'event',
      event: {
        type: 'agent-message',
        from: input.sourceNodeId,
        to: input.targetNodeId,
        title: input.outcome,
        ...(input.reason ? { reason: input.reason } : {})
      }
    })
    if (ok) traced = 'board-log'
  } catch {
    traced = 'memory' // an exception from the shell's appender is the same fact as `false`
  }
  ring.push({
    traceId,
    ts,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    outcome: input.outcome,
    ...(input.receipt ? { receipt: input.receipt } : {}),
    bodyChars: input.bodyChars,
    traced
  })
  while (ring.length > TRACE_RING_CAPACITY) ring.shift()
  return { traceId, traced }
}

/** The most recent deliveries, NEWEST FIRST — the same order `parseLines` hands the board log back,
 *  so a UI can concatenate the two without re-sorting. */
export function recentDeliveries(limit = TRACE_RING_CAPACITY): DeliveryTraceEntry[] {
  const n = Math.max(0, Math.min(limit, ring.length))
  return ring.slice(ring.length - n).reverse()
}

export function resetAgentMessageTraceForTests(): void {
  ring.length = 0
}
