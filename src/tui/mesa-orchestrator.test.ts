import { describe, expect, it } from 'vitest'
import { applyTuiCommand, parseTuiLine, renderTuiHelp } from './mesa-orchestrator'

describe('Mesa orchestrator TUI', () => {
  it('keeps slash commands in this TUI', () => {
    expect(parseTuiLine('/help').kind).toBe('command')
    expect(parseTuiLine('/activate A').kind).toBe('command')
    expect(parseTuiLine('Diseña una API').kind).toBe('prompt')
    expect(renderTuiHelp()).toContain('/approve')
    expect(renderTuiHelp()).toContain('/activate')
  })

  it('/activate wakes a role and refuses a healthy orchestrator pane', () => {
    const a = applyTuiCommand(null, parseTuiLine('/activate A'))
    expect(a.action).toEqual({ type: 'activate', arg: 'A' })
    const o = applyTuiCommand(null, parseTuiLine('/activate O'))
    expect(o.action).toBeUndefined()
    expect(o.reply).toContain('/activate')
  })

  it('/activate retries a failed role, including O, and does not re-dispatch a live one', () => {
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
      tasks: [
        {
          id: 'm-O',
          missionId: 'm',
          roleId: 'O' as const,
          dependsOn: [],
          goalVersion: 1,
          instruction: 'plan',
          acceptanceCriteria: ['plan-presented'],
          artifactRefs: [],
          status: 'failed' as const
        },
        {
          id: 'm-A',
          missionId: 'm',
          roleId: 'A' as const,
          dependsOn: ['m-O'],
          goalVersion: 1,
          instruction: 'research',
          acceptanceCriteria: ['A-done'],
          artifactRefs: [],
          status: 'accepted' as const
        }
      ],
      executions: [],
      artifacts: [],
      approvals: [],
      budget: { hard: false, spent: { kind: 'unavailable' as const }, reserved: { kind: 'unavailable' as const } }
    }
    const retryO = applyTuiCommand(base, parseTuiLine('/activate O'))
    expect(retryO.action).toEqual({ type: 'activate', arg: 'O' })
    expect(retryO.reply).toContain('Reintentando')
    const liveA = applyTuiCommand(base, parseTuiLine('/activate A'))
    expect(liveA.action).toBeUndefined()
    expect(liveA.reply).toContain('ya está activo')

    const running = applyTuiCommand(
      {
        ...base,
        tasks: [{ ...base.tasks[1], status: 'running' }]
      },
      parseTuiLine('/activate A')
    )
    expect(running.action).toBeUndefined()
    expect(running.reply).toContain('sigue en curso')
    expect(running.reply).toContain('validado')
    expect(running.reply).not.toMatch(/error/i)
  })

  it('/activate does not dispatch while the mission is paused or cancelled', () => {
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
      paused: true,
      cancelled: false,
      createdAt: 1,
      tasks: [],
      executions: [],
      artifacts: [],
      approvals: [],
      budget: { hard: false, spent: { kind: 'unavailable' as const }, reserved: { kind: 'unavailable' as const } }
    }
    const paused = applyTuiCommand(base, parseTuiLine('/activate A'))
    expect(paused.action).toBeUndefined()
    expect(paused.reply).toContain('pausa')
    const cancelled = applyTuiCommand({ ...base, paused: false, cancelled: true }, parseTuiLine('/activate A'))
    expect(cancelled.action).toBeUndefined()
    expect(cancelled.reply).toContain('cancelada')
  })

  it('a prompt becomes a set-goal action', () => {
    const r = applyTuiCommand(null, parseTuiLine('Diseña una API de inventario.'))
    expect(r.action).toEqual({ type: 'set-goal', arg: 'Diseña una API de inventario.' })
    expect(r.reply).toContain('Objetivo recibido')
  })

  it('/plan lists dormant 1→4→16 roles, not only live tasks', () => {
    const r = applyTuiCommand(
      {
        id: 'm',
        projectId: 'p',
        orchestratorNodeId: 'n',
        title: 'API',
        goal: {
          version: 1,
          objective: 'Diseña una API',
          constraints: [],
          acceptanceCriteria: ['plan-presented'],
          decisionRefs: []
        },
        paused: false,
        cancelled: false,
        createdAt: 1,
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
            status: 'ready'
          }
        ],
        executions: [],
        artifacts: [],
        approvals: [],
        budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
      },
      parseTuiLine('/plan')
    )
    expect(r.reply).toContain('A dormido')
    expect(r.reply).toContain('C1 dormido')
  })
})
