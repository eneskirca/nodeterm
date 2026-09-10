// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_SWARM_ROLES } from '@shared/swarm/types'
import { MissionInspector } from './MissionInspector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MissionInspector preview', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows the 1→4→16 tree as dormido and does not render unknown cost as $0', () => {
    act(() => {
      root.render(<MissionInspector mission={null} onClose={() => {}} />)
    })
    const text = host.textContent ?? ''
    expect(text).toContain('Sin objetivo todavía')
    expect(text).toContain('No disponible')
    expect(text).not.toMatch(/\$0/)
    for (const id of ALL_SWARM_ROLES) {
      expect(text).toContain(id)
    }
    expect((text.match(/dormido/g) ?? []).length).toBe(ALL_SWARM_ROLES.length)
    expect(host.querySelectorAll('button.mesa-inspector__role:disabled').length).toBe(ALL_SWARM_ROLES.length)
  })

  it('names that writers cannot isolate without a local folder', () => {
    act(() => {
      root.render(
        <MissionInspector
          mission={{
            id: 'm',
            projectId: 'p',
            orchestratorNodeId: 'n',
            title: 'API',
            goal: {
              version: 1,
              objective: 'x',
              constraints: [],
              acceptanceCriteria: [],
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
          }}
          onClose={() => {}}
        />
      )
    })
    expect(host.textContent).toContain('Sin carpeta local')
    expect(host.textContent).toContain('SSH o canvas sin carpeta')
  })

  it('names a hard-budget dispatch stop without inventing $0', () => {
    act(() => {
      root.render(
        <MissionInspector
          mission={{
            id: 'm',
            projectId: 'p',
            orchestratorNodeId: 'n',
            title: 'API',
            goal: {
              version: 1,
              objective: 'x',
              constraints: [],
              acceptanceCriteria: [],
              decisionRefs: []
            },
            paused: false,
            cancelled: false,
            createdAt: 1,
            tasks: [],
            executions: [],
            artifacts: [],
            approvals: [],
            budget: {
              hard: true,
              limitUsd: 1,
              spent: { kind: 'unavailable' },
              reserved: { kind: 'unavailable' },
              blockedReason: 'hard-limit needs an adapter that can enforce spend'
            }
          }}
          onClose={() => {}}
        />
      )
    })
    expect(host.textContent).toContain('no puede imponer un límite duro')
    expect(host.textContent).not.toMatch(/\$0/)
  })

  it('does not offer role activation while the mission is paused', () => {
    act(() => {
      root.render(
        <MissionInspector
          mission={{
            id: 'm',
            projectId: 'p',
            orchestratorNodeId: 'n',
            title: 'API',
            goal: {
              version: 1,
              objective: 'x',
              constraints: [],
              acceptanceCriteria: [],
              decisionRefs: []
            },
            paused: true,
            cancelled: false,
            createdAt: 1,
            tasks: [],
            executions: [],
            artifacts: [],
            approvals: [],
            budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
          }}
          onActivate={() => {}}
          onClose={() => {}}
        />
      )
    })
    expect(host.textContent).toContain('Misión en pausa')
    expect(host.querySelectorAll('button.mesa-inspector__role:disabled').length).toBe(
      ALL_SWARM_ROLES.length
    )
  })

  it('lets you retry a failed role', () => {
    act(() => {
      root.render(
        <MissionInspector
          mission={{
            id: 'm',
            projectId: 'p',
            orchestratorNodeId: 'n',
            title: 'API',
            goal: {
              version: 1,
              objective: 'x',
              constraints: [],
              acceptanceCriteria: [],
              decisionRefs: []
            },
            paused: false,
            cancelled: false,
            createdAt: 1,
            tasks: [
              {
                id: 'm-A',
                missionId: 'm',
                roleId: 'A',
                dependsOn: [],
                goalVersion: 1,
                instruction: 'research',
                acceptanceCriteria: ['A-done'],
                artifactRefs: [],
                status: 'failed'
              }
            ],
            executions: [],
            artifacts: [],
            approvals: [],
            budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
          }}
          onActivate={() => {}}
          onClose={() => {}}
        />
      )
    })
    expect(host.textContent).toContain('Falló · reintentar')
    const a = [...host.querySelectorAll('button.mesa-inspector__role')].find((el) =>
      el.textContent?.includes('Investigación')
    )
    expect(a).toBeTruthy()
    expect((a as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows requested vs effective CLI and Sin conexión', () => {
    act(() => {
      root.render(
        <MissionInspector
          mission={{
            id: 'm',
            projectId: 'p',
            orchestratorNodeId: 'n',
            title: 'API',
            goal: {
              version: 1,
              objective: 'x',
              constraints: [],
              acceptanceCriteria: ['shipped'],
              decisionRefs: []
            },
            paused: false,
            cancelled: false,
            createdAt: 1,
            tasks: [
              {
                id: 'm-A',
                missionId: 'm',
                roleId: 'A',
                dependsOn: [],
                goalVersion: 1,
                instruction: 'research',
                acceptanceCriteria: ['A-done'],
                artifactRefs: [],
                status: 'running',
                requestedAgent: 'grok',
                requestedModel: 'grok-4',
                observeState: 'unobservable'
              }
            ],
            executions: [],
            artifacts: [],
            approvals: [],
            budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
          }}
          onClose={() => {}}
        />
      )
    })
    expect(host.textContent).toContain('Sin conexión')
    expect(host.textContent).toContain('CLI grok / grok-4 · Efectivo: No confirmado')
    expect(host.textContent).toContain('Sin verificar')
  })
})
