// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SwarmMission } from '@shared/swarm/types'
import type { CanvasNode } from '../../state/workspace'
import { MissionRoster } from './MissionRoster'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function node(id: string, title: string): CanvasNode {
  return {
    id,
    type: 'terminal',
    position: { x: 0, y: 0 },
    data: { title, color: '#0a84ff', group: null, callsign: title.slice(0, 1) }
  } as unknown as CanvasNode
}

const orch = node('n-o', 'Orch')
const research = node('n-a', 'Research')

const mission: SwarmMission = {
  id: 'm',
  projectId: 'p',
  orchestratorNodeId: 'n-o',
  title: 'API',
  goal: {
    version: 1,
    objective: 'Inventario',
    constraints: [],
    acceptanceCriteria: [],
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
      acceptanceCriteria: [],
      artifactRefs: [],
      status: 'accepted',
      nodeId: 'n-o'
    },
    {
      id: 'm-A',
      missionId: 'm',
      roleId: 'A',
      dependsOn: ['m-O'],
      goalVersion: 1,
      instruction: 'research',
      acceptanceCriteria: [],
      artifactRefs: [],
      status: 'running',
      nodeId: 'n-a'
    }
  ],
  executions: [],
  artifacts: [],
  approvals: [],
  budget: { hard: false, spent: { kind: 'unavailable' }, reserved: { kind: 'unavailable' } }
}

describe('MissionRoster hierarchy', () => {
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

  it('lets you focus a bound coordinator — it is not only a fold header', () => {
    const onSelect = vi.fn()
    const byId = new Map<string, CanvasNode>([
      ['n-o', orch],
      ['n-a', research]
    ])
    act(() => {
      root.render(
        <MissionRoster
          query=""
          onQuery={() => {}}
          mission={mission}
          columns={[{ id: null, title: 'Libre', color: '#888', nodeIds: ['n-o', 'n-a'] }]}
          grouped={false}
          byId={byId}
          focusId="n-o"
          talk={null}
          match={() => true}
          missionNodeIds={new Set(['n-o', 'n-a'])}
          openCoords={{ A: true }}
          snippetOf={(n) => String(n.data.title ?? '')}
          onToggleCoord={() => {}}
          onSelect={onSelect}
          onTalk={() => {}}
          onDragStart={() => {}}
          onDragOverCol={() => {}}
          onDropCol={() => {}}
          onRenameGroup={() => {}}
          onAddInColumn={() => {}}
          onActivate={() => {}}
        />
      )
    })
    const names = [...host.querySelectorAll('.mesa-row__name')].map((el) => el.textContent)
    expect(names).toContain('Orch')
    expect(names).toContain('Research')
    const researchRow = [...host.querySelectorAll('.mesa-row')].find((el) =>
      el.textContent?.includes('Research')
    )
    expect(researchRow).toBeTruthy()
    act(() => {
      researchRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('n-a')
    onSelect.mockClear()
    const coordBtn = [...host.querySelectorAll('.mesa-roster__coord-btn')].find((el) =>
      el.textContent?.includes('Investigación')
    )
    expect(coordBtn).toBeTruthy()
    act(() => {
      coordBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('n-a')
  })

  it('activates a dormant coordinator or worker without focusing a pane', () => {
    const onSelect = vi.fn()
    const onActivate = vi.fn()
    const onlyO: SwarmMission = {
      ...mission,
      tasks: mission.tasks.filter((t) => t.roleId === 'O')
    }
    act(() => {
      root.render(
        <MissionRoster
          query=""
          onQuery={() => {}}
          mission={onlyO}
          columns={[{ id: null, title: 'Libre', color: '#888', nodeIds: ['n-o'] }]}
          grouped={false}
          byId={new Map([['n-o', orch]])}
          focusId="n-o"
          talk={null}
          match={() => true}
          missionNodeIds={new Set(['n-o'])}
          openCoords={{ A: true }}
          snippetOf={(n) => String(n.data.title ?? '')}
          onToggleCoord={() => {}}
          onSelect={onSelect}
          onTalk={() => {}}
          onDragStart={() => {}}
          onDragOverCol={() => {}}
          onDropCol={() => {}}
          onRenameGroup={() => {}}
          onAddInColumn={() => {}}
          onActivate={onActivate}
        />
      )
    })
    const coordBtn = [...host.querySelectorAll('.mesa-roster__coord-btn')].find((el) =>
      el.textContent?.includes('Investigación')
    )
    expect(coordBtn?.textContent).toContain('dormido · activar')
    act(() => {
      coordBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onActivate).toHaveBeenCalledWith('A')
    expect(onSelect).not.toHaveBeenCalled()
    onActivate.mockClear()
    const a1 = [...host.querySelectorAll('.mesa-row.is-asleep.is-activatable')].find((el) =>
      el.textContent?.includes('A1')
    )
    expect(a1).toBeTruthy()
    act(() => {
      a1!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onActivate).toHaveBeenCalledWith('A1')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
