// @vitest-environment jsdom
//
// Bug D, Task 6: the LIST surfaces — the sessions sidebar, the project-tab unread dot, the kanban
// cards and the card modal — read each project's agent status from the store of the session that
// PROJECT belongs to. A handed-off SSH project (local session, the default store) and the team tab
// now serving it (relay session, its own keyless store) hold the SAME node ids, so a list that read
// one store for every row showed the team tab's agents as Unknown, or the SSH project's state on
// the team tab's row.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeTerminalApi, Project } from '@shared/types'
import {
  agentStatusForProject,
  bindProjectToSession,
  createSession,
  disposeSession,
  getSessionStores,
  resetSessionsForTest,
  setActiveSession,
  setOfflineRelayApiFactory
} from './session'
import { lookupFromStores, useAgentStatusLookup, useAgentStatusSig, type AgentStatusLookup } from './agent-status-lookup'
import { defaultAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { parseUnreadSig, unreadSigFor } from '../components/TabBar'
import { SessionCard } from '../components/kanban/SessionCard'
import type { KanbanSession } from '../components/kanban/KanbanView'

vi.mock('../components/ContextMeter', () => ({ ContextMeter: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The local session's api IS `window.nodeTerminal`, and state/agentStatus.ts seeds its api memo with
// that object at module load — which is what makes the local session's store the DEFAULT one.
// Hoisted so the seed happens before that import evaluates, exactly as in the app.
const LOCAL_API = vi.hoisted(() => {
  const api = { marker: 'local' }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = api
  return api
}) as unknown as NodeTerminalApi
const OFFLINE_API = { marker: 'offline' } as unknown as NodeTerminalApi

const SSH_PROJECT = 'project-ssh-handed-off'
const TEAM_PROJECT = 'project-team-tab'
const NODE = 'term-shared-node'

const project = (id: string, remote: boolean): Project =>
  ({ id, name: id, color: '#888', nodes: [{ id: NODE }], ...(remote ? { remote: true } : {}) }) as unknown as Project

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetSessionsForTest()
  setActiveSession(createSession('local', LOCAL_API, 'This machine').id)
  setOfflineRelayApiFactory(() => OFFLINE_API)
  useProjects.setState({ projects: [project(SSH_PROJECT, false), project(TEAM_PROJECT, true)], activeProjectId: TEAM_PROJECT })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setOfflineRelayApiFactory(null)
  useProjects.setState({ projects: [], activeProjectId: '' })
  defaultAgentStatus.store.setState({ byId: {}, activeId: null })
  localStorage.clear()
})

/** A team tab joined over the relay: its own session, bound to the team project. A fresh api per
 *  join: the relay store is memoized BY API IDENTITY (`agentStatusForApi`), so a shared api object
 *  would carry one test's statuses into the next — and a reconnect is a new connection's api. */
function joinTeam(): string {
  const relay = createSession('relay', { marker: 'relay' } as unknown as NodeTerminalApi, 'Team')
  bindProjectToSession(TEAM_PROJECT, relay.id)
  return relay.id
}

const relayStore = (sessionId: string) => getSessionStores(sessionId).agentStatus.store

describe('useAgentStatusLookup', () => {
  it('useAgentStatusLookup re-renders on a relay store change and on a reconnect', () => {
    const first = joinTeam()
    let renders = 0
    function Probe() {
      renders++
      const lookup = useAgentStatusLookup([SSH_PROJECT, TEAM_PROJECT])
      const team = lookup(TEAM_PROJECT, NODE)?.state ?? '-'
      const ssh = lookup(SSH_PROJECT, NODE)?.state ?? '-'
      return <span>{`${team}/${ssh}`}</span>
    }
    act(() => root.render(<Probe />))
    expect(host.textContent).toBe('-/-')

    // A host event lands in the team tab's own store: its row moves, the SSH project's does not.
    act(() => relayStore(first).getState().setState(NODE, 'working', 'claude'))
    expect(host.textContent).toBe('working/-')
    // And the SSH project's entry under the same id is the default store's.
    act(() => defaultAgentStatus.store.getState().setState(NODE, 'done', 'claude'))
    expect(host.textContent).toBe('working/done')

    // A reconnect: the old session goes, a new one (another api, so another store) takes the tab.
    // The lookup re-resolves the project to the NEW store…
    const firstStore = relayStore(first)
    const second = joinTeam()
    act(() => disposeSession(first))
    expect(relayStore(second)).not.toBe(firstStore)
    expect(host.textContent).toBe('-/done')
    // …and is subscribed to it: a change there re-renders, a change in the dead one does not.
    act(() => relayStore(second).getState().setState(NODE, 'blocked', 'claude'))
    expect(host.textContent).toBe('blocked/done')
    const before = renders
    act(() => firstStore.getState().setState(NODE, 'working', 'claude'))
    expect(renders).toBe(before)
    expect(host.textContent).toBe('blocked/done')
  })

  it('useAgentStatusSig does not re-render on a change that leaves the signature alone', () => {
    const relay = joinTeam()
    let renders = 0
    function Probe() {
      renders++
      const sig = useAgentStatusSig([TEAM_PROJECT], (lookup) => (lookup(TEAM_PROJECT, NODE)?.unread ? 'unread' : 'read'))
      return <span>{sig}</span>
    }
    act(() => root.render(<Probe />))
    expect(host.textContent).toBe('read')
    const settled = renders

    // State flips that leave `unread` alone: the signature is the same string, nothing re-renders.
    act(() => relayStore(relay).getState().setState(NODE, 'working', 'claude'))
    act(() => relayStore(relay).getState().setState(NODE, 'waiting', 'claude'))
    expect(renders).toBe(settled)

    act(() => relayStore(relay).getState().markUnread(NODE))
    expect(host.textContent).toBe('unread')
    expect(renders).toBe(settled + 1)
  })
  it('useAgentStatusSig re-subscribes after a reconnect that leaves the signature unchanged', () => {
    // The common case: a team tab with nothing unread reconnects ('read' -> 'read'), or an offline
    // remote tab binds. The signature does not move, so nothing re-renders, and the hook must still
    // follow the project to its NEW store — a re-subscribe that waited for a render never happened,
    // and the tab dot stayed dark for every later unread.
    let renders = 0
    function Probe() {
      renders++
      const sig = useAgentStatusSig([TEAM_PROJECT], (lookup) => (lookup(TEAM_PROJECT, NODE)?.unread ? 'unread' : 'read'))
      return <span>{sig}</span>
    }
    // Unbound remote tab: the offline session's empty store.
    act(() => root.render(<Probe />))
    expect(host.textContent).toBe('read')

    // It binds: same signature, no re-render — and the relay store is the one listened to.
    let first = ''
    act(() => {
      first = joinTeam()
    })
    expect(host.textContent).toBe('read')
    act(() => relayStore(first).getState().markUnread(NODE))
    expect(host.textContent).toBe('unread')
    act(() => relayStore(first).getState().clearUnread(NODE))
    expect(host.textContent).toBe('read')

    // A reconnect: a new session (new api, new store) takes the tab, the old one is disposed.
    const settled = renders
    act(() => {
      joinTeam()
      disposeSession(first)
    })
    expect(renders, 'an unchanged signature re-renders nothing').toBe(settled)
    act(() => agentStatusForProject(TEAM_PROJECT).store.getState().markUnread(NODE))
    expect(host.textContent).toBe('unread')
  })
})

describe('unreadSigFor', () => {
  it("unreadSigFor counts a relay project's unread from its own store, not the default one", () => {
    const relay = joinTeam()
    const projects = useProjects.getState().projects
    const counts = (): ReadonlyMap<string, number> =>
      parseUnreadSig(unreadSigFor(projects, lookupFromStores([SSH_PROJECT, TEAM_PROJECT])))

    expect(counts().size).toBe(0)
    // Unread on the team tab's own store: the team tab's dot, never the SSH project's.
    act(() => relayStore(relay).getState().markUnread(NODE))
    expect(counts().get(TEAM_PROJECT)).toBe(1)
    expect(counts().get(SSH_PROJECT)).toBeUndefined()
    expect(defaultAgentStatus.store.getState().byId[NODE]?.unread).toBeFalsy()

    // And the reverse: the default store's unread is the SSH project's, not the team tab's.
    act(() => relayStore(relay).getState().clearUnread(NODE))
    act(() => defaultAgentStatus.store.getState().markUnread(NODE))
    expect(counts().get(SSH_PROJECT)).toBe(1)
    expect(counts().get(TEAM_PROJECT)).toBeUndefined()
  })
})

describe('SessionCard', () => {
  const card: KanbanSession = { id: NODE, title: 'agent', color: '#fff', kind: 'terminal', spawn: {} }
  const noop = (): void => {}
  const renderCard = (statusStore?: ReturnType<typeof relayStore>): void =>
    act(() =>
      root.render(
        <SessionCard
          session={card}
          onOpen={noop}
          onDragStart={noop}
          onDragEnd={noop}
          onDropAt={noop}
          onContext={noop}
          liveLinkSource="relay"
          statusStore={statusStore}
        />
      )
    )

  it("a SessionCard given statusStore shows that store's badge", () => {
    const relay = joinTeam()
    act(() => relayStore(relay).getState().setState(NODE, 'working', 'claude'))
    // The default store says something else under the same id (the handed-off SSH project).
    act(() => defaultAgentStatus.store.getState().setState(NODE, 'waiting', 'claude'))

    renderCard(relayStore(relay))
    expect(host.querySelector('.kanban-badge--running')?.textContent).toBe('RUNNING')
    expect(host.querySelector('.kanban-badge--needs')).toBeNull()
    // Live: the card follows ITS store.
    act(() => relayStore(relay).getState().setState(NODE, 'blocked', 'claude'))
    expect(host.querySelector('.kanban-badge--needs')?.textContent).toBe('NEEDS YOU')

    // Absent = the default store, exactly as before.
    act(() => relayStore(relay).getState().setState(NODE, 'working', 'claude'))
    renderCard(undefined)
    expect(host.querySelector('.kanban-badge--needs')?.textContent).toBe('NEEDS YOU')
    expect(host.querySelector('.kanban-badge--running')).toBeNull()
  })
})

// Source pins: the boards, the card modal and the modal terminal need Canvas, a pty and a project
// on disk to mount.
const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

/** The text from `start` up to (not including) the first `end` after it; fails loudly if either is
 *  missing, so a renamed anchor reads as a broken pin rather than an empty, passing slice. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0)
  const to = text.indexOf(end, from + start.length)
  expect(to, `end anchor not found after ${start}: ${end}`).toBeGreaterThan(from)
  return text.slice(from, to)
}

describe('the board surfaces read the store of the project they show', () => {
  it('CardModal and ModalTerminal read the session store', () => {
    for (const f of ['components/kanban/CardModal.tsx', 'components/kanban/ModalTerminal.tsx']) {
      const src = read(f)
      expect(src, f).not.toMatch(/\buseAgentStatus\b/)
      expect(src, f).toContain('const agentStatusStore = useSessionStores().agentStatus.store')
    }
    // The modal terminal's file insert reads the pane's agent off the same store.
    const insertFiles = between(read('components/kanban/ModalTerminal.tsx'), 'const insertFiles = async (', 'const onDrop = async')
    expect(insertFiles).toContain('const st = agentStatusStore.getState().byId[nodeId]')
  })

  it('both boards hand SessionCard a per-project store and clear unread on it', () => {
    // The memo re-resolves on a registry change: a reconnect swaps the project's store.
    const resolvesPerProject = (src: string): void => {
      expect(src).toContain('const registryVersion = useSessionRegistryVersion()')
      const memo = between(src, 'const statusStore = useMemo(', '\n  )')
      expect(memo).toContain('() => agentStatusForProject(projectId).store,')
      expect(memo).toContain('[projectId, registryVersion]')
    }
    const board = read('components/kanban/KanbanView.tsx')
    expect(board).not.toMatch(/\buseAgentStatus\b/)
    resolvesPerProject(board)
    expect(between(board, '<SessionCard', '/>')).toContain('statusStore={statusStore}')
    expect(board).toContain('if (modalNodeId) statusStore.getState().clearUnread(modalNodeId)')
    expect(board).toContain('const statusSig = statusStore((st) => statusChipSig(st.byId, chipCards))')

    const global = read('components/kanban/GlobalKanbanView.tsx')
    expect(global).not.toMatch(/\buseAgentStatus\b/)
    const lane = between(global, 'const Swimlane = memo(function Swimlane(', 'export const GlobalKanbanView')
    resolvesPerProject(lane)
    expect(between(lane, '<SessionCard', '/>')).toContain('statusStore={statusStore}')
    // The overview's open card is cleared on ITS lane's project store, never the default one.
    expect(global).toContain('const modalProjectId = modal?.projectId ?? null')
    expect(global).toContain(
      'if (modalNodeId) agentStatusForProject(modalProjectId).store.getState().clearUnread(modalNodeId)'
    )
  })

  it('TerminalNode, the board card and the card modal hand their store to the team and account chips', () => {
    // Neither chip reads the default store unconditionally: absent = default, given = that store.
    const team = read('components/TeamProgressChip.tsx')
    expect(team).not.toMatch(/useAgentStatus\(\(/)
    expect(team).toContain('const sig = (statusStore ?? useAgentStatus)((s) => teamProgressSig(s.byId, stations))')
    const account = read('components/AccountChip.tsx')
    expect(account).not.toMatch(/useAgentStatus\(\(/)
    expect(account).toContain(
      'const multiple = (statusStore ?? useAgentStatus)((s) => hasMultipleAccountKeys(s.byId, dataAccountId, accounts))'
    )

    const node = read('nodes/TerminalNode.tsx')
    expect(node).toContain('const accountChip = useAccountChip(data.accountId, observedAccount, agentStatusStore)')
    expect(node).toContain(
      '{team && <TeamProgressChip stations={team} onTravel={travelToStation} menuZIndex={60} statusStore={agentStatusStore} />}'
    )
    const cardSrc = read('components/kanban/SessionCard.tsx')
    expect(cardSrc).toContain('const accountChip = useAccountChip(session.spawn.accountId, status?.account, statusStore)')
    expect(cardSrc).toContain('<TeamProgressChip stations={team} onTravel={onTravel} statusStore={statusStore} />')
    const modal = read('components/kanban/CardModal.tsx')
    expect(modal).toContain('const accountChip = useAccountChip(session.spawn.accountId, observedAccount, agentStatusStore)')
    expect(modal).toContain('<TeamProgressChip stations={team} onTravel={onTravel} statusStore={agentStatusStore} />')
  })
})

// Type-level: the lookup is the shape the builders consume.
const _shape: AgentStatusLookup = lookupFromStores([])
void _shape
