import type { StructuredTaskResult } from '../../../shared/swarm/schemas'
import type { SwarmTask } from '../../../shared/swarm/types'
import type { AgentAdapter, StartTaskResult } from './types'

export function createMockAdapter(): AgentAdapter {
  const results = new Map<string, StructuredTaskResult>()
  let n = 0
  return {
    id: 'mock',
    capabilities: {
      structuredResults: true,
      usageReporting: 'estimated',
      cancellation: true,
      modelSelection: 'none',
      hardBudgetEnforcement: true
    },
    async startTask(task: SwarmTask): Promise<StartTaskResult> {
      n += 1
      const executionId = `mock-exec-${n}`
      results.set(executionId, {
        taskId: task.id,
        summary: `Mock completed ${task.roleId}`,
        evidence: [`mock://${task.roleId}`],
        criteriaMet: task.acceptanceCriteria.length ? [...task.acceptanceCriteria] : ['mock-ok'],
        usage: { kind: 'estimated', usd: 0.25 }
      })
      return { executionId, sessionName: `nt-mock-${task.id}` }
    },
    async cancelTask(executionId: string): Promise<boolean> {
      return results.delete(executionId)
    },
    async collectResult(executionId: string): Promise<StructuredTaskResult | null> {
      return results.get(executionId) ?? null
    },
    async recoverExecution(executionId: string) {
      return results.has(executionId)
        ? ({ state: 'turn-ended', source: 'result-file' } as const)
        : ({ state: 'lost' } as const)
    }
  }
}
