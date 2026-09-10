import { parseStructuredTaskResult, type StructuredTaskResult } from '../../../shared/swarm/schemas'
import type { SwarmTask } from '../../../shared/swarm/types'
import type { AgentAdapter, ExecutionObservation, StartTaskResult } from './types'

export type FakeCliScript = {
  recover: ExecutionObservation
  result?: StructuredTaskResult | null
  outputBytes?: number
}

/**
 * Test double for a real agent CLI. Scripts recover/result; it never types into tmux.
 * Use this for contract acceptance before opt-in smokes against installed CLIs.
 */
export function createFakeCliAdapter(opts: {
  scriptFor: (task: SwarmTask, executionId: string) => FakeCliScript
  outputSink?: (bytes: Buffer) => void
  outputCapBytes?: number
}): AgentAdapter {
  const results = new Map<string, StructuredTaskResult | null>()
  const recover = new Map<string, ExecutionObservation>()
  const outputCap = opts.outputCapBytes ?? 64 * 1024
  let n = 0
  return {
    id: 'fake-cli',
    capabilities: {
      structuredResults: true,
      usageReporting: 'none',
      cancellation: true,
      modelSelection: 'none',
      hardBudgetEnforcement: false
    },
    async startTask(task: SwarmTask): Promise<StartTaskResult> {
      n += 1
      const executionId = `fake-${task.id}-${n}`
      const step = opts.scriptFor(task, executionId)
      recover.set(executionId, step.recover)
      results.set(executionId, step.result === undefined ? null : step.result)
      const extra = step.outputBytes ?? 0
      if (extra > 0) {
        const capped = Math.min(extra, outputCap)
        opts.outputSink?.(Buffer.alloc(capped, 0x61))
      }
      return { executionId, requestedAgent: task.agentId, requestedModel: task.agentModel }
    },
    async cancelTask(executionId: string): Promise<boolean> {
      return recover.delete(executionId)
    },
    async collectResult(executionId: string): Promise<StructuredTaskResult | null> {
      const raw = results.get(executionId)
      if (!raw) return null
      return parseStructuredTaskResult(raw)
    },
    async recoverExecution(executionId: string): Promise<ExecutionObservation> {
      return recover.get(executionId) ?? { state: 'lost' }
    }
  }
}
