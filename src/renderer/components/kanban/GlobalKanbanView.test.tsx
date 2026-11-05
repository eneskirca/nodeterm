import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { compareSwimlanePriority, swimlanePriorityTier } from '../../lib/kanban'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from './KanbanView'

const GLOBAL_KANBAN_SRC = fs.readFileSync(path.join(__dirname, 'GlobalKanbanView.tsx'), 'utf8')

describe('global kanban swimlane collapse wiring', () => {
  it('starts empty lanes collapsed, auto-recollapses after idle, and toggles the lane body from its header', () => {
    expect(GLOBAL_KANBAN_SRC).toContain('const [collapsed, setCollapsed] = useState(() => sessions.length === 0)')
    expect(GLOBAL_KANBAN_SRC).toContain('EMPTY_SWIMLANE_COLLAPSE_MS')
    expect(GLOBAL_KANBAN_SRC).toContain('onClick={toggleCollapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('aria-expanded={!collapsed}')
    expect(GLOBAL_KANBAN_SRC).toContain('setCollapsed((value) => !value)')
    expect(GLOBAL_KANBAN_SRC).toContain('{!collapsed && (')
  })
})

describe('global kanban priority sorting', () => {
  const board: ProjectKanban = {
    columns: [
      { id: 'c-ref', title: 'Refinamento', color: '#0a84ff' },
      { id: 'c-contrato', title: 'Contrato e UX', color: '#ffd60a' },
      { id: 'c-impl', title: 'Implementacao', color: '#ff453a' },
      { id: 'c-qa', title: 'Conferencia e QA', color: '#bf5af2' },
      { id: 'c-entrega', title: 'Entrega', color: '#32d74b' }
    ],
    assignments: []
  }
  const sess = (id: string): KanbanSession => ({
    id,
    title: id,
    color: '#fff',
    kind: 'terminal',
    spawn: {} as never
  })

  it('orders NeedsYou (tier 0) > working/running (tier 1) > idle/read (tier 2) > empty (tier 3)', () => {
    expect(swimlanePriorityTier(board, [], {}).tier).toBe(3)
    expect(
      swimlanePriorityTier(
        board,
        [sess('s1')],
        {}
      ).tier
    ).toBe(2)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-impl' }] },
        [sess('s1')],
        {}
      ).tier
    ).toBe(1)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-ref' }] },
        [sess('s1')],
        { s1: { state: 'working' } }
      ).tier
    ).toBe(1)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-ref' }] },
        [sess('s1')],
        { s1: { state: 'waiting' } }
      ).tier
    ).toBe(0)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-impl' }] },
        [sess('s1')],
        { s1: { state: 'done', unread: true, lastEventAt: 2000 } }
      ).tier
    ).toBe(0)
    expect(
      swimlanePriorityTier(
        { ...board, assignments: [{ nodeId: 's1', columnId: 'c-impl' }] },
        [sess('s1')],
        { s1: { state: 'done', unread: false, lastEventAt: 2000 } },
        9999
      )
    ).toEqual({ tier: 2, comigoCount: 0, workingCount: 0, lastEventAt: 0 })
  })

  it('within the same priority tier, orders chronologically from oldest to newest and ignores working timestamps', () => {
    const olderNeedsYou = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's1', columnId: 'c-ref' }] },
      [sess('s1')],
      { s1: { state: 'waiting', lastEventAt: 1000 } }
    )
    const newerNeedsYou = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's2', columnId: 'c-ref' }] },
      [sess('s2')],
      { s2: { state: 'waiting', lastEventAt: 5000 } }
    )
    const noClockNeedsYou = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's4', columnId: 'c-ref' }] },
      [sess('s4')],
      { s4: { state: 'waiting' } }
    )
    const workingRecent = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's3', columnId: 'c-impl' }] },
      [sess('s3')],
      { s3: { state: 'working', lastEventAt: 9000 } }
    )
    expect(workingRecent.lastEventAt).toBe(0)
    const sorted = [
      { id: 'working-recent', priority: workingRecent, originalIdx: 0 },
      { id: 'no-clock-comigo', priority: noClockNeedsYou, originalIdx: 1 },
      { id: 'newer-comigo', priority: newerNeedsYou, originalIdx: 2 },
      { id: 'older-comigo', priority: olderNeedsYou, originalIdx: 3 }
    ].sort(compareSwimlanePriority)
    expect(sorted.map((x) => x.id)).toEqual(['older-comigo', 'newer-comigo', 'no-clock-comigo', 'working-recent'])
  })

  it('keeps an already-read session in a stage column at tier 2 (idle) instead of promoting to tier 0 or tier 1', () => {
    const readSessionInStage = swimlanePriorityTier(
      { ...board, assignments: [{ nodeId: 's1', columnId: 'c-ref' }] },
      [sess('s1')],
      { s1: { state: 'done', unread: false, lastEventAt: 1000 } },
      8000
    )
    expect(readSessionInStage.tier).toBe(2)
  })
})

describe('global kanban card read state', () => {
  it('clears the unread dot when a card opens, like the per-project board', () => {
    // On the store of the card's own lane project (bug D): a team lane reads its relay session's.
    expect(GLOBAL_KANBAN_SRC).toContain(
      "import { agentStatusForProject, sessionForProject, useSessionRegistryVersion } from '../../session/session'"
    )
    expect(GLOBAL_KANBAN_SRC).toContain(
      'if (modalNodeId) agentStatusForProject(modalProjectId).store.getState().clearUnread(modalNodeId)'
    )
  })

  it('stabilizes swimlane board, column lanes, and sort-order selector so priority mode only re-renders when lane order changes', () => {
    expect(GLOBAL_KANBAN_SRC).toContain('storedSessionsFor(p.nodes)')
    expect(GLOBAL_KANBAN_SRC).toContain('defaultBoardFor(p.id)')
    expect(GLOBAL_KANBAN_SRC).toContain('onChangeBoard={onChangeBoard}')
    expect(GLOBAL_KANBAN_SRC).toContain('const lanesByColumn = useMemo(')
    expect(GLOBAL_KANBAN_SRC).toContain('const sortOrderSig = useSyncExternalStore(')
  })
})
