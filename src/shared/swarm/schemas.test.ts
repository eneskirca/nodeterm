import { describe, expect, it } from 'vitest'
import {
  countActivatedRoles,
  countVerifiedGoalCriteria,
  formatBudgetLine,
  formatRolePlan,
  mesaFolderRoot,
  mesaUniqueFolderCandidate,
  missionProgress,
  parseStructuredTaskResult,
  parseSwarmMission,
  parseTaskUsage,
  needsWorkerPane,
  roleNeedsActivation,
  roleWritesFiles,
  taskFailLabel,
  taskLifecycleLabel,
  cliEffectiveLabel,
  writerWorktreeBlock,
  writerWorktreeBlockLabel
} from './schemas'

describe('mesaFolderRoot', () => {
  it('uses only an explicit absolute project cwd', () => {
    expect(mesaFolderRoot('/repo')).toBe('/repo')
    expect(mesaFolderRoot('.')).toBeUndefined()
    expect(mesaFolderRoot(undefined)).toBeUndefined()
  })

  it('proposes a folder only when the extra cwd set is unique', () => {
    expect(mesaUniqueFolderCandidate(['/a', '/a'])).toBe('/a')
    expect(mesaUniqueFolderCandidate(['/a', '/b'])).toBeUndefined()
    expect(mesaUniqueFolderCandidate(['relative', '/abs'])).toBe('/abs')
  })
})

describe('countActivatedRoles', () => {
  it('does not count O plan-presented as 1/1 mission complete', () => {
    expect(
      countActivatedRoles({
        tasks: [
          {
            id: 'm-O',
            missionId: 'm',
            roleId: 'O',
            dependsOn: [],
            goalVersion: 1,
            instruction: 'plan',
            acceptanceCriteria: ['plan-presented'],
            artifactRefs: [],
            status: 'accepted'
          },
          {
            id: 'm-C1',
            missionId: 'm',
            roleId: 'C1',
            dependsOn: [],
            goalVersion: 1,
            instruction: 'write',
            acceptanceCriteria: ['C1-done'],
            artifactRefs: [],
            status: 'waiting_approval'
          }
        ]
      })
    ).toEqual({ met: 0, total: 1 })
  })
})

describe('countVerifiedGoalCriteria', () => {
  it('does not treat O TUI stamps or turn-end as verified goal criteria', () => {
    expect(
      countVerifiedGoalCriteria({
        goal: {
          version: 1,
          objective: 'x',
          constraints: [],
          acceptanceCriteria: ['plan-presented', 'shipped'],
          decisionRefs: []
        },
        artifacts: [
          {
            id: 'a',
            missionId: 'm',
            taskId: 'm-O',
            kind: 'structured-result',
            payload: {
              taskId: 'm-O',
              summary: 'Goal held in Mesa TUI',
              evidence: ['tui'],
              criteriaMet: ['plan-presented']
            }
          }
        ]
      })
    ).toEqual({ met: 0, total: 2 })
    expect(
      countVerifiedGoalCriteria({
        goal: {
          version: 1,
          objective: 'x',
          constraints: [],
          acceptanceCriteria: ['plan-presented'],
          decisionRefs: []
        },
        artifacts: [
          {
            id: 'b',
            missionId: 'm',
            taskId: 'm-A',
            kind: 'structured-result',
            payload: {
              taskId: 'm-A',
              summary: 'Plan listed',
              evidence: ['plan.md'],
              criteriaMet: ['plan-presented']
            }
          }
        ]
      })
    ).toEqual({ met: 1, total: 1 })
  })
})

describe('formatBudgetLine', () => {
  it('never prints unknown spend as zero', () => {
    expect(formatBudgetLine({ kind: 'unavailable' }).label).toBe('No disponible')
    expect(formatBudgetLine({ kind: 'unavailable', usd: 0 }).label).toBe('No disponible')
    expect(formatBudgetLine({ kind: 'estimated', usd: 1.2 }).label).toBe('~$1.20')
    expect(formatBudgetLine({ kind: 'measured', usd: 1.2 }).label).toBe('$1.20')
  })
})

describe('parseStructuredTaskResult', () => {
  it('requires evidence-shaped criteria, not an idle badge', () => {
    expect(parseStructuredTaskResult({ taskId: 't', summary: 'ok', evidence: [], criteriaMet: [] })).toBeNull()
  })
})

describe('parseTaskUsage', () => {
  it('ignores missing or zero-shaped unknown spend', () => {
    expect(parseTaskUsage({ taskId: 't' })).toBeNull()
    expect(parseTaskUsage({ usage: { kind: 'unavailable', usd: 0 } })).toBeNull()
    expect(parseTaskUsage({ usage: { kind: 'estimated' } })).toBeNull()
    expect(parseTaskUsage({ usage: { kind: 'measured', usd: 1.5 } })).toEqual({
      kind: 'measured',
      usd: 1.5
    })
  })
})

describe('formatRolePlan', () => {
  it('keeps unused 1→4→16 roles dormido until activated', () => {
    const plan = formatRolePlan([{ roleId: 'O', status: 'ready' }])
    expect(plan).toContain('O ready')
    expect(plan).toContain('A dormido')
    expect(plan).toContain('C1 dormido')
    expect(plan).toContain('D4 dormido')
    expect(roleWritesFiles('C1')).toBe(true)
    expect(roleWritesFiles('C')).toBe(false)
    expect(roleNeedsActivation(undefined)).toBe(true)
    expect(roleNeedsActivation({ status: 'running' })).toBe(false)
    expect(roleNeedsActivation({ status: 'failed' })).toBe(true)
    expect(roleNeedsActivation({ status: 'needs_review' })).toBe(true)
  })
})

describe('needsWorkerPane', () => {
  it('spawns only while the live adapter still needs a pane', () => {
    expect(needsWorkerPane({ roleId: 'A', status: 'ready' })).toBe(true)
    expect(needsWorkerPane({ roleId: 'A', status: 'queued' })).toBe(true)
    expect(needsWorkerPane({ roleId: 'A', status: 'running' })).toBe(true)
    expect(needsWorkerPane({ roleId: 'C1', status: 'waiting_approval' })).toBe(true)
    expect(needsWorkerPane({ roleId: 'A', status: 'accepted' })).toBe(false)
    expect(needsWorkerPane({ roleId: 'A', status: 'failed' })).toBe(false)
    expect(needsWorkerPane({ roleId: 'A', status: 'cancelled' })).toBe(false)
    expect(needsWorkerPane({ roleId: 'A', status: 'stale' })).toBe(false)
    expect(needsWorkerPane({ roleId: 'O', status: 'ready' })).toBe(false)
    expect(needsWorkerPane({ roleId: 'A', status: 'ready', nodeId: 'n1' })).toBe(false)
  })
})

describe('parseSwarmMission', () => {
  it('refuses a file that would crash the host tick', () => {
    expect(parseSwarmMission(null)).toBeNull()
    expect(parseSwarmMission({ id: 'm1' })).toBeNull()
    expect(
      parseSwarmMission({
        id: 'm1',
        projectId: 'p1',
        orchestratorNodeId: 'n1',
        title: 'API',
        goal: { version: 1, objective: 'x' },
        tasks: 'nope'
      })
    ).toBeNull()
    expect(
      parseSwarmMission({
        id: '../etc',
        projectId: 'p1',
        orchestratorNodeId: 'n1',
        title: 'API',
        goal: { version: 1, objective: 'x' },
        tasks: []
      })
    ).toBeNull()
  })

  it('drops a relative workspaceRoot and unknown spend instead of inventing $0', () => {
    const m = parseSwarmMission({
      id: 'm1',
      projectId: 'p1',
      orchestratorNodeId: 'n1',
      title: 'API',
      goal: { version: 1, objective: 'Inventario', constraints: [], acceptanceCriteria: ['plan-presented'] },
      createdAt: 1,
      paused: false,
      cancelled: false,
      workspaceRoot: '.',
      tasks: [
        {
          id: 'm1-O',
          missionId: 'm1',
          roleId: 'O',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'plan',
          acceptanceCriteria: ['plan-presented'],
          artifactRefs: [],
          status: 'accepted'
        }
      ],
      executions: [],
      artifacts: [],
      approvals: [],
      budget: { hard: false, spent: { kind: 'unavailable', usd: 0 }, reserved: { kind: 'unavailable' } }
    })
    expect(m?.goal.objective).toBe('Inventario')
    expect(m?.workspaceRoot).toBeUndefined()
    expect(m?.budget.spent).toEqual({ kind: 'unavailable' })
    expect(m?.tasks).toHaveLength(1)
  })

  it('keeps a worktree blockedReason and names the SSH / cwd-less case', () => {
    const m = parseSwarmMission({
      id: 'm1',
      projectId: 'p1',
      orchestratorNodeId: 'n1',
      title: 'API',
      goal: { version: 1, objective: 'Inventario' },
      createdAt: 1,
      tasks: [
        {
          id: 'm1-O',
          missionId: 'm1',
          roleId: 'O',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'plan',
          acceptanceCriteria: ['plan-presented'],
          artifactRefs: [],
          status: 'accepted'
        }
      ],
      approvals: [
        {
          id: 'ap1',
          missionId: 'm1',
          taskId: 'm1-C1',
          action: { command: 'write-workspace', args: ['C1'], cwd: '', scope: 'worktree' },
          status: 'pending',
          blockedReason: 'no-workspace-root'
        }
      ],
      budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
    })
    expect(m?.approvals[0]?.blockedReason).toBe('no-workspace-root')
    expect(writerWorktreeBlock({ workspaceRoot: undefined })).toBe('no-workspace-root')
    expect(writerWorktreeBlock({ workspaceRoot: '/repo' })).toBeNull()
    expect(writerWorktreeBlockLabel('no-workspace-root')).toContain('Sin carpeta local')
    expect(writerWorktreeBlockLabel('no-workspace-root')).toContain('Open folder')
    expect(writerWorktreeBlockLabel('no-workspace-root')).not.toMatch(/\$0/)
    expect(writerWorktreeBlockLabel('not-a-git-repo')).toContain('inicializar git')
    expect(writerWorktreeBlockLabel('empty-git-repo')).toContain('commit inicial')
  })
})

describe('missionProgress', () => {
  const base = {
    id: 'm',
    projectId: 'p',
    orchestratorNodeId: 'n',
    title: 'API',
    goal: {
      version: 1,
      objective: 'x',
      constraints: [],
      acceptanceCriteria: ['plan-presented'],
      decisionRefs: []
    },
    paused: false,
    cancelled: false,
    createdAt: 1,
    executions: [],
    artifacts: [],
    approvals: [],
    budget: { hard: false, spent: { kind: 'unavailable' as const }, reserved: { kind: 'unavailable' as const } }
  }

  it('does not call a ready-only mission Lista / done', () => {
    const idle = missionProgress({
      ...base,
      tasks: [
        {
          id: 'm-O',
          missionId: 'm',
          roleId: 'O',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'plan',
          acceptanceCriteria: ['plan-presented'],
          artifactRefs: [],
          status: 'accepted'
        }
      ]
    })
    expect(idle.kind).toBe('idle')
    expect(idle.label).not.toMatch(/Lista|Terminada/)

    const running = missionProgress({
      ...base,
      tasks: [
        {
          id: 'm-O',
          missionId: 'm',
          roleId: 'O',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'plan',
          acceptanceCriteria: ['plan-presented'],
          artifactRefs: [],
          status: 'accepted'
        },
        {
          id: 'm-C1',
          missionId: 'm',
          roleId: 'C1',
          dependsOn: ['m-C'],
          goalVersion: 1,
          instruction: 'write',
          acceptanceCriteria: ['C1-done'],
          artifactRefs: [],
          status: 'running'
        }
      ]
    })
    expect(running.kind).toBe('in-progress')
    expect(running.label).toContain('C1 running')
    expect(running.hint).toMatch(/validar el resultado/i)

    const built = missionProgress({
      ...base,
      tasks: [
        {
          id: 'm-O',
          missionId: 'm',
          roleId: 'O',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'plan',
          acceptanceCriteria: ['plan-presented'],
          artifactRefs: [],
          status: 'accepted'
        },
        {
          id: 'm-C1',
          missionId: 'm',
          roleId: 'C1',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'write',
          acceptanceCriteria: ['C1-done'],
          artifactRefs: [],
          status: 'accepted'
        }
      ]
    })
    expect(built.kind).toBe('unvalidated')
    expect(built.label).toContain('validación no corrió')
  })
})

describe('taskLifecycleLabel / cliEffectiveLabel', () => {
  it('names Arrancando, Trabajando, Turno terminado, Validando, Aceptado, Sin conexión', () => {
    expect(taskLifecycleLabel(undefined)).toBe('dormido')
    expect(taskLifecycleLabel({ status: 'running', observeState: 'starting' })).toBe('Arrancando')
    expect(taskLifecycleLabel({ status: 'running' })).toBe('Trabajando')
    expect(taskLifecycleLabel({ status: 'running', observeState: 'turn-ended' })).toBe('Turno terminado')
    expect(taskLifecycleLabel({ status: 'validating' })).toBe('Validando')
    expect(taskLifecycleLabel({ status: 'accepted' })).toBe('Aceptado')
    expect(taskLifecycleLabel({ status: 'running', observeState: 'unobservable' })).toBe('Sin conexión')
    expect(taskLifecycleLabel({ status: 'needs_review', failReason: 'lost-observation' })).toBe(
      'Sin conexión'
    )
  })

  it('shows requested CLI vs unconfirmed pane', () => {
    expect(
      cliEffectiveLabel({
        requestedAgent: 'grok',
        requestedModel: 'grok-4',
        agentId: 'grok',
        agentModel: 'grok-4'
      })
    ).toBe('CLI grok / grok-4 · Efectivo: No confirmado')
    expect(
      cliEffectiveLabel({
        requestedAgent: 'gemini',
        observedPane: 'gemini'
      })
    ).toBe('CLI gemini · Efectivo: gemini')
  })

  it('keeps formatRolePlan status tokens for the plan text', () => {
    expect(formatRolePlan([{ roleId: 'O', status: 'ready' }])).toContain('O ready')
  })

  it('persists observe + requested CLI fields through parseSwarmMission', () => {
    const parsed = parseSwarmMission({
      id: 'm1',
      projectId: 'p1',
      orchestratorNodeId: 'n1',
      title: 'API',
      createdAt: 1,
      paused: false,
      cancelled: false,
      goal: { version: 1, objective: 'x', constraints: [], acceptanceCriteria: ['plan-presented'], decisionRefs: [] },
      tasks: [
        {
          id: 'm1-A',
          roleId: 'A',
          dependsOn: [],
          goalVersion: 1,
          instruction: 'research',
          acceptanceCriteria: ['A-done'],
          artifactRefs: [],
          status: 'running',
          observeState: 'unobservable',
          observeSince: 42,
          requestedAgent: 'grok',
          requestedModel: 'grok-4',
          observedPane: 'zsh'
        }
      ],
      executions: [],
      artifacts: [],
      approvals: [],
      budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
    })
    expect(parsed?.tasks[0]).toMatchObject({
      observeState: 'unobservable',
      observeSince: 42,
      requestedAgent: 'grok',
      requestedModel: 'grok-4',
      observedPane: 'zsh'
    })
  })

  it('labels lost-observation and scoped-approval refusals', () => {
    expect(taskFailLabel('lost-observation')).toMatch(/Sin conexión/)
    expect(writerWorktreeBlockLabel('unsupported-approval')).toMatch(/alcance permitido/)
  })
})

