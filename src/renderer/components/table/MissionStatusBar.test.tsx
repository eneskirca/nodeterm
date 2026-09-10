// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SwarmMission } from '@shared/swarm/types'
import { MissionStatusBar, pendingSwarmApprovals } from './MissionStatusBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mission(over: Partial<SwarmMission> = {}): SwarmMission {
  return {
    id: 'm',
    projectId: 'p',
    orchestratorNodeId: 'n-o',
    title: 'API',
    goal: {
      version: 1,
      objective: 'Inventario',
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
        status: 'waiting_approval'
      }
    ],
    executions: [],
    artifacts: [],
    approvals: [
      {
        id: 'ap-1',
        missionId: 'm',
        taskId: 'm-C1',
        action: { command: 'write-workspace', args: ['C1'], cwd: '/tmp/mesa-c1', scope: 'worktree' },
        status: 'pending'
      }
    ],
    budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } },
    ...over
  }
}

describe('MissionStatusBar approvals', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('exposes Aprobar C1 without opening the inspector', () => {
    const onApprove = vi.fn()
    act(() => {
      root.render(
        <MissionStatusBar
          mission={mission({ workspaceRoot: '/repo' })}
          inspectOpen={false}
          onToggleInspect={() => {}}
          onApprove={onApprove}
        />
      )
    })
    const btn = [...host.querySelectorAll('button')].find((el) => el.textContent === 'Aprobar C1')
    expect(btn).toBeTruthy()
    act(() => btn!.click())
    expect(onApprove).toHaveBeenCalledWith('ap-1')
  })

  it('disables Aprobar C1 when the mission has no local folder', () => {
    act(() => {
      root.render(
        <MissionStatusBar
          mission={mission({ workspaceRoot: undefined })}
          inspectOpen={false}
          onToggleInspect={() => {}}
          onApprove={vi.fn()}
        />
      )
    })
    expect(host.textContent).toContain('Sin carpeta local')
    const btn = [...host.querySelectorAll('button')].find((el) => el.textContent === 'Aprobar C1')
    expect(btn).toBeTruthy()
    expect(btn).toHaveProperty('disabled', true)
  })

  it('names waiting approval instead of Lista', () => {
    act(() => {
      root.render(
        <MissionStatusBar
          mission={mission({ workspaceRoot: '/repo' })}
          inspectOpen={false}
          onToggleInspect={() => {}}
        />
      )
    })
    expect(host.textContent).toContain('Esperando aprobación: C1')
    expect(host.textContent).not.toContain('Lista')
    expect(host.textContent).not.toContain('Terminada')
  })

  it('hides pending approvals on a paused or cancelled mission', () => {
    expect(pendingSwarmApprovals(mission({ paused: true }))).toEqual([])
    expect(pendingSwarmApprovals(mission({ cancelled: true }))).toEqual([])
    expect(pendingSwarmApprovals(mission()).map((a) => a.id)).toEqual(['ap-1'])
  })
})
