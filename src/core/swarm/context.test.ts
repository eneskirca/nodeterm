import { describe, expect, it } from 'vitest'
import { compactGoal, taskBrief } from './context'

const goal = {
  version: 2,
  objective: 'Diseña una API de inventario.',
  constraints: ['No file edits without approval'],
  acceptanceCriteria: ['plan-presented'],
  decisionRefs: []
}

describe('taskBrief', () => {
  it('puts the versioned goal above the role work', () => {
    const text = taskBrief(goal, {
      id: 'm-A',
      missionId: 'm',
      roleId: 'A',
      dependsOn: [],
      goalVersion: 2,
      instruction: 'Investigación',
      acceptanceCriteria: ['A-done'],
      artifactRefs: [],
      status: 'queued'
    })
    expect(text.startsWith('v2: Diseña una API de inventario.')).toBe(true)
    expect(text).toContain('Role A: Investigación')
    expect(text).toContain('Accept: plan-presented')
  })

  it('compactGoal never drops the version', () => {
    expect(compactGoal(goal)).toContain('v2:')
    expect(compactGoal(goal)).toContain('API de inventario')
  })
})
