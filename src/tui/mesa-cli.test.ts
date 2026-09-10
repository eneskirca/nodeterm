import { describe, expect, it } from 'vitest'
import { banner, handleCliLine, type MesaCliRuntime } from './mesa-cli'
import type { SwarmMission } from '../shared/swarm/types'

function fake(mission: SwarmMission | null): MesaCliRuntime & { mission: SwarmMission | null } {
  const rt = {
    mission,
    load: () => rt.mission,
    async setGoal(objective: string) {
      if (!rt.mission) return null
      rt.mission = {
        ...rt.mission,
        goal: { ...rt.mission.goal, version: rt.mission.goal.version + 1, objective }
      }
      return rt.mission
    },
    async pause() {
      if (!rt.mission) return null
      rt.mission = { ...rt.mission, paused: true }
      return rt.mission
    },
    async resume() {
      if (!rt.mission) return null
      rt.mission = { ...rt.mission, paused: false }
      return rt.mission
    },
    async cancel() {
      if (!rt.mission) return null
      rt.mission = { ...rt.mission, cancelled: true, paused: true }
      return rt.mission
    },
    async approve(id: string) {
      if (!rt.mission) return null
      rt.mission = {
        ...rt.mission,
        approvals: rt.mission.approvals.map((a) =>
          a.id === id ? { ...a, blockedReason: 'no-workspace-root' } : a
        )
      }
      return rt.mission
    },
    async activate(roleId: string) {
      if (!rt.mission) return null
      rt.mission = {
        ...rt.mission,
        tasks: [
          ...rt.mission.tasks,
          {
            id: `t-${roleId}`,
            missionId: rt.mission.id,
            roleId: roleId as SwarmMission['tasks'][number]['roleId'],
            dependsOn: [],
            goalVersion: rt.mission.goal.version,
            instruction: roleId,
            acceptanceCriteria: [`${roleId}-done`],
            artifactRefs: [],
            status: 'queued'
          }
        ]
      }
      return rt.mission
    }
  }
  return rt
}

const seed = (): SwarmMission => ({
  id: 'm1',
  projectId: 'p',
  orchestratorNodeId: 'n1',
  title: 'API',
  goal: {
    version: 1,
    objective: 'old',
    constraints: [],
    acceptanceCriteria: ['plan-presented'],
    decisionRefs: []
  },
  paused: false,
  cancelled: false,
  createdAt: 1,
  tasks: [],
  executions: [],
  artifacts: [],
  approvals: [],
  budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
})

describe('mesa-cli', () => {
  it('records a typed objective on the mission', async () => {
    const rt = fake(seed())
    const out = await handleCliLine('Diseña una API de inventario.', rt)
    expect(out.reply).toContain('Objetivo recibido')
    expect(out.mission?.goal.objective).toBe('Diseña una API de inventario.')
    expect(out.mission?.goal.version).toBe(2)
  })

  it('pause is a TUI command, not a shell fallback', async () => {
    const rt = fake(seed())
    const out = await handleCliLine('/pause', rt)
    expect(out.mission?.paused).toBe(true)
    expect(banner()).toContain('orquestador')
  })

  it('/approve names a blocked worktree instead of claiming success', async () => {
    const rt = fake({
      ...seed(),
      approvals: [
        {
          id: 'ap1',
          missionId: 'm1',
          taskId: 'm1-C1',
          action: { command: 'write-workspace', args: ['C1'], cwd: '', scope: 'worktree' },
          status: 'pending'
        }
      ]
    })
    const out = await handleCliLine('/approve ap1', rt)
    expect(out.reply).toContain('Sin carpeta local')
    expect(out.mission?.approvals[0]?.status).toBe('pending')
  })

  it('/activate A records the role on the host mission', async () => {
    const rt = fake(seed())
    const out = await handleCliLine('/activate A', rt)
    expect(out.reply).toContain('Activando A')
    expect(out.mission?.tasks.some((t) => t.roleId === 'A')).toBe(true)
  })
})
