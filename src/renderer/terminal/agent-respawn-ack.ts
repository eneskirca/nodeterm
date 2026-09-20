import { modelRespawnTrace } from '@shared/model-respawn-trace'

export type AgentRespawnAck =
  | { ok: true }
  | { ok: false; detail: string; reason?: 'agent-not-running' }

export const AGENT_NOT_RUNNING_AFTER_RESPAWN =
  'the replacement terminal submitted its resume command, but the agent process did not stay running'

interface PendingRespawn {
  generation: number
  timer: ReturnType<typeof setTimeout>
  resolve: (result: AgentRespawnAck) => void
}

const pending = new Map<string, PendingRespawn>()
let nextGeneration = 0
// A missing-session response adds a shell probe and a second settled/verified delivery before
// process proof. Those bounded stages alone can take 29 seconds; allow cold PTY creation and
// project/transcript preflight too, while retaining one finite deadline for the whole attempt.
export const AGENT_RESPAWN_ACK_TIMEOUT_MS = 60_000

function settle(nodeId: string, generation: number, result: AgentRespawnAck): boolean {
  const entry = pending.get(nodeId)
  if (!entry || entry.generation !== generation) return false
  pending.delete(nodeId)
  clearTimeout(entry.timer)
  entry.resolve(result)
  modelRespawnTrace('respawn.ack', {
    nodeId,
    generation,
    ok: result.ok,
    // `detail` is user-facing and may eventually include provider/transport text. Keep that out
    // of the log even though today's callers only pass controlled sentences.
    reason: result.ok ? 'replacement-agent-running' : 'replacement-lifecycle-failed'
  })
  return true
}

/**
 * Bridge the restart closure (which requests a React lifecycle respawn) to the NEXT lifecycle
 * effect (which alone knows whether `transport.create` and the cold-resume launch succeeded).
 */
export function beginAgentRespawn(
  nodeId: string,
  timeoutMs = AGENT_RESPAWN_ACK_TIMEOUT_MS
): { generation: number; promise: Promise<AgentRespawnAck>; cancel: (detail: string) => void } {
  const generation = ++nextGeneration
  const previous = pending.get(nodeId)
  if (previous) {
    clearTimeout(previous.timer)
    previous.resolve({ ok: false, detail: 'a newer respawn superseded this attempt' })
    modelRespawnTrace('respawn.superseded', {
      nodeId,
      oldGeneration: previous.generation,
      newGeneration: generation
    })
  }
  let resolve!: (result: AgentRespawnAck) => void
  const promise = new Promise<AgentRespawnAck>((done) => {
    resolve = done
  })
  const timer = setTimeout(() => {
    settle(nodeId, generation, {
      ok: false,
      detail: 'the replacement terminal did not become ready in time'
    })
  }, timeoutMs)
  pending.set(nodeId, { generation, timer, resolve })
  modelRespawnTrace('respawn.awaiting', { nodeId, generation, timeoutMs })
  return {
    generation,
    promise,
    cancel: (detail: string) => {
      settle(nodeId, generation, { ok: false, detail })
    }
  }
}

export function agentRespawnPending(nodeId: string, generation?: number): boolean {
  const entry = pending.get(nodeId)
  return !!entry && (generation === undefined || entry.generation === generation)
}

/** Called by the replacement TerminalNode lifecycle. Stale/no-waiter reports are harmless. */
export function reportAgentRespawn(
  nodeId: string,
  generation: number,
  result: AgentRespawnAck
): boolean {
  const entry = pending.get(nodeId)
  if (!entry || entry.generation !== generation) {
    modelRespawnTrace('respawn.report-ignored', {
      nodeId,
      generation,
      pendingGeneration: entry?.generation,
      reason: entry ? 'stale-generation' : 'no-waiter'
    })
    return false
  }
  return settle(nodeId, generation, result)
}

/** Test isolation; production never clears a live ticket except by settling it. */
export function __resetAgentRespawnAckForTests(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, detail: 'test reset' })
  }
  pending.clear()
  nextGeneration = 0
}
