import type { StructuredTaskResult } from '../../../shared/swarm/schemas'
import type { SwarmTask } from '../../../shared/swarm/types'

export interface AdapterCapabilities {
  structuredResults: boolean
  usageReporting: 'exact' | 'estimated' | 'none'
  cancellation: boolean
  modelSelection: 'launch' | 'session' | 'none'
  hardBudgetEnforcement: boolean
}

export interface StartTaskResult {
  executionId: string
  sessionName?: string
  /** Pane missing or not a shell yet — do not mark the task running; tick will retry. */
  deferred?: boolean
  /** Harness/prompt cannot be launched. Do not retry as deferred. */
  refused?: boolean
  refuseReason?: string
  requestedAgent?: string
  requestedModel?: string
}

/**
 * Process / pane observation. Not task acceptance.
 * `turn-ended` means collect a result and validate it. It is never `accepted` by itself.
 */
export type ExecutionObservation =
  | { state: 'starting'; paneCommand?: string }
  | { state: 'running'; paneCommand?: string }
  | {
      state: 'turn-ended'
      source: 'hook' | 'process-exit' | 'result-file'
      exitCode?: number
    }
  | { state: 'unobservable'; reason: string; since?: number }
  | { state: 'never-started'; reason: string }
  | { state: 'lost'; reason?: string }

export type TurnEndedEvent = {
  eventId: string
  missionId?: string
  taskId?: string
  executionId: string
  nodeId: string
  launchGeneration: number
  observedAt: number
  source: 'hook' | 'process-exit'
  /** SessionEnd of a previous CLI must not close a fresh execution. */
  hookKind?: 'stop' | 'session-end'
  /** Agent session the hook claims. Mismatch with the launch is a stale event. */
  sessionId?: string
}

export interface AgentAdapter {
  id: string
  capabilities: AdapterCapabilities
  startTask(task: SwarmTask & { launchGeneration?: number }): Promise<StartTaskResult>
  cancelTask(executionId: string): Promise<boolean>
  collectResult(executionId: string): Promise<StructuredTaskResult | null>
  recoverExecution(executionId: string): Promise<ExecutionObservation>
  /**
   * Host-owned turn-end (hook or IPC). Records that a turn ended.
   * Must not write a fabricated StructuredTaskResult.
   */
  noteTurnEnded?(event: TurnEndedEvent): Promise<boolean>
}
