// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Project, SessionMemoryRow } from '@shared/types'
import { useAgentStatus } from '../state/agentStatus'
import { useProjects } from '../state/projects'
import { useSessionMemory } from '../state/sessionMemory'
import { SessionMemoryPanel } from './SessionMemoryPanel'
import type { SessionPauseOffer } from '../lib/sessionPause'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Web',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

const node = (id: string, title: string): Project['nodes'][number] =>
  ({ id, kind: 'terminal', title, position: { x: 0, y: 0 } }) as unknown as Project['nodes'][number]

const row = (over: Partial<SessionMemoryRow> & { nodeId: string }): SessionMemoryRow => ({
  session: `nt-${over.nodeId}`,
  panePid: 100,
  selfMb: over.totalMb ?? 0,
  childrenMb: 0,
  childCount: 0,
  totalMb: 0,
  command: 'bash',
  ...over
})

/**
 * The FIXTURE is the whole test, so it has to discriminate every branch on its own:
 *   - `t1` has children, so `selfMb` and `totalMb` differ (a header that summed the pane process
 *     alone would print 1.2 GB where the truth is 1.5 GB).
 *   - `t3` lives in a CLOSED project — the one row that proves the panel feeds `resolveSessionRows`
 *     every project rather than the open tabs.
 *   - `t2` is a real node with NO agent state: the row that separates "orphan" from "no state". A
 *     fixture where every non-orphan happened to be `working` would let `state === null` pass as a
 *     stand-in for `orphan`.
 *   - `ghost` has no node anywhere — the actual orphan.
 */
const ROWS: SessionMemoryRow[] = [
  row({ nodeId: 't1', selfMb: 600, childrenMb: 300, childCount: 2, totalMb: 900, command: 'claude' }),
  row({ nodeId: 't3', selfMb: 500, totalMb: 500, command: 'codex' }),
  row({ nodeId: 't2', selfMb: 120, totalMb: 120, command: 'bash' }),
  row({ nodeId: 'ghost', selfMb: 40, totalMb: 40, command: 'zsh' })
]

const PROJECTS: Project[] = [
  project({ id: 'p1', name: 'Web', nodes: [node('t1', 'Big agent'), node('t2', 'Plain shell')] }),
  project({ id: 'p2', name: 'Old', closed: true, nodes: [node('t3', 'Parked session')] })
]

let host: HTMLDivElement
let root: Root
let onGoToNode: Mock<(nodeId: string) => void>
let onKillSession: Mock<(nodeId: string, orphan: boolean) => void>
let onClose: Mock<() => void>
let refreshFull: Mock<(scopeKey: string, projectId?: string) => Promise<void>>
let startHostPoll: Mock<(scopeKey: string, projectId?: string) => void>
let stopHostPoll: Mock<() => void>
let onPauseSession: Mock<(nodeId: string) => Promise<void>>
/** What `pauseOfferFor` answers for a row. Canvas owns the real decision (`sessionPauseOffer`);
 *  the panel only draws it, so the harness supplies it directly. Default = the pre-feature panel:
 *  no row offers a pause, so every existing assertion sees exactly the old DOM. */
let pauseOffer: (nodeId: string) => SessionPauseOffer = () => ({ show: false })

function mount(over: Partial<ReturnType<typeof useSessionMemory.getState>> = {}): void {
  useSessionMemory.setState({
    ok: true,
    rows: ROWS,
    loadedScope: '',
    loading: false,
    refreshFull,
    startHostPoll,
    stopHostPoll,
    ...over
  })
  host = document.createElement('div')
  root = createRoot(host)
  act(() =>
    root.render(
      <SessionMemoryPanel
        onGoToNode={onGoToNode}
        onKillSession={onKillSession}
        pauseOfferFor={(id) => pauseOffer(id)}
        onPauseSession={onPauseSession}
        onClose={onClose}
      />
    )
  )
}

const rowsOf = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.sessmem-row')]
const mainOf = (i: number): HTMLButtonElement =>
  rowsOf()[i].querySelector<HTMLButtonElement>('.sessmem-row__main')!
const killOf = (i: number): HTMLButtonElement =>
  rowsOf()[i].querySelector<HTMLButtonElement>('.sessmem-row__kill')!
const pauseOf = (i: number): HTMLButtonElement | null =>
  rowsOf()[i].querySelector<HTMLButtonElement>('.sessmem-row__pause')
const text = (): string => host.textContent ?? ''

beforeEach(() => {
  onGoToNode = vi.fn<(nodeId: string) => void>()
  onKillSession = vi.fn<(nodeId: string, orphan: boolean) => void>()
  onClose = vi.fn<() => void>()
  refreshFull = vi.fn<(scopeKey: string, projectId?: string) => Promise<void>>(async () => {})
  startHostPoll = vi.fn<(scopeKey: string, projectId?: string) => void>()
  stopHostPoll = vi.fn<() => void>()
  onPauseSession = vi.fn<(nodeId: string) => Promise<void>>(async () => {})
  pauseOffer = () => ({ show: false })
  useProjects.setState({ projects: PROJECTS, activeProjectId: 'p1' })
  useAgentStatus.setState({ byId: { t1: { state: 'working', unread: false } } })
})

afterEach(() => {
  act(() => root.unmount())
})

describe('SessionMemoryPanel', () => {
  it('renders every row in the order core sorted them', () => {
    mount()
    // No re-sort here: core already sorted by total descending, and a second sort would let the
    // panel and the report disagree about which session is the biggest.
    expect(rowsOf().map((r) => r.querySelector('.sessmem-row__title')?.textContent)).toEqual([
      'Big agent',
      'Parked session',
      'Plain shell',
      'nt-ghost'
    ])
    expect(rowsOf().map((r) => r.querySelector('.sessmem-row__cmd')?.textContent)).toEqual([
      'claude',
      'codex',
      'bash',
      'zsh'
    ])
  })

  it('never truncates the list', () => {
    // A cap would have to be a visible "showing top N" line; a silent slice would hide exactly the
    // sessions a user opened this panel to find.
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ nodeId: `n${i}`, selfMb: 100 - i, totalMb: 100 - i })
    )
    mount({ rows: many })
    expect(rowsOf()).toHaveLength(12)
  })

  it('totals the row TOTAL, children included', () => {
    mount()
    // 900 + 500 + 120 + 40 = 1560 MB. Summing `selfMb` instead would print 1.2 GB.
    expect(host.querySelector('.sessmem-panel__total')?.textContent).toBe('1.5 GB')
  })

  it("resolves a CLOSED project's session to its real title", () => {
    // closeProject keeps the project and its nodes on disk. Passing only the open tabs would turn
    // every parked session into an orphan — silently, in this file, with the suite green.
    mount()
    const parked = rowsOf()[1]
    expect(parked.querySelector('.sessmem-row__title')?.textContent).toBe('Parked session')
    expect(parked.querySelector('.sessmem-row__project')?.textContent).toBe('Old')
    expect(mainOf(1).disabled).toBe(false)
    expect(parked.querySelector('.sessmem-row__orphan')).toBeNull()
  })

  it('reads orphan-ness from the row, never from a missing agent state', () => {
    mount()
    // `t2` is a plain terminal: a real node with a real title that never enters the agent-status
    // map. Deriving orphan-ness from `state === null` would flag it — and every other plain
    // terminal on the canvas — as a session with nowhere to travel.
    expect(mainOf(2).disabled).toBe(false)
    expect(rowsOf()[2].querySelector('.sessmem-row__orphan')).toBeNull()
    expect(rowsOf()[2].querySelector('.sessmem-row__dot--hollow')).toBeNull()
    // The real orphan, by contrast.
    expect(mainOf(3).disabled).toBe(true)
    expect(rowsOf()[3].querySelector('.sessmem-row__orphan')).not.toBeNull()
    expect(rowsOf()[3].querySelector('.sessmem-row__dot--hollow')).not.toBeNull()
  })

  it('travels to a resolvable row and closes', () => {
    mount()
    act(() => mainOf(0).click())
    expect(onGoToNode).toHaveBeenCalledWith('t1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('travels to a CLOSED project session too', () => {
    mount()
    act(() => mainOf(1).click())
    expect(onGoToNode).toHaveBeenCalledWith('t3')
  })

  it('leaves an orphan row inert but still killable', () => {
    mount()
    act(() => mainOf(3).click())
    expect(onGoToNode).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    act(() => killOf(3).click())
    expect(onKillSession).toHaveBeenCalledWith('ghost', true)
  })

  it('kills a resolvable row as a non-orphan', () => {
    mount()
    act(() => killOf(0).click())
    expect(onKillSession).toHaveBeenCalledWith('t1', false)
    // Killing is not travelling: the panel stays put behind its confirm dialog.
    expect(onGoToNode).not.toHaveBeenCalled()
  })

  it('names the extra processes as CHILD processes, not as MCP servers', () => {
    mount()
    // `childCount` counts every descendant of the pane — the agent CLI itself plus whatever it
    // spawned — because `pane_pid` is the pane's SHELL. Calling them MCP servers would miscount
    // (claude + 2 MCP servers reads as 3) and mislabel a plain `npm run dev`.
    const kids = rowsOf()[0].querySelector('.sessmem-row__kids')?.textContent ?? ''
    expect(kids).toContain('2 child processes')
    expect(kids).toContain('300.0 MB')
    expect(text()).not.toContain('MCP')
    // Only the row that has children gets the sub-line.
    expect(host.querySelectorAll('.sessmem-row__kids')).toHaveLength(1)
  })

  it('says it could not measure — never an empty list, never a zero', () => {
    // `loadedScope: ''` on purpose, and it is the realistic shape: the store's failure path sets
    // `ok:false, rows:[]` and leaves `loadedScope` where the last SUCCESSFUL sweep put it. So a
    // panel that decided "have we measured?" from the scope stamp alone would find a match here and
    // render a confident `0 MB` / `0 sessions` over a sweep that failed — with a `loadedScope: null`
    // fixture it would have fallen into "Measuring…" and passed.
    mount({ ok: false, rows: [], loadedScope: '' })
    expect(text()).toContain('Could not measure')
    expect(rowsOf()).toHaveLength(0)
    expect(host.querySelector('.sessmem-panel__total')).toBeNull()
    expect(text()).not.toContain('0 sessions')
    // Not `not.toContain('0 MB')`: `formatBytes(0)` is "0 B", so spelling one unit would have let
    // the zero through. Without a reading there is no number we are entitled to print at all —
    // the same rule the pill holds itself to.
    expect(text()).not.toMatch(/\d/)
    // "We could not look" is the one state where the retry matters most.
    expect(host.querySelector<HTMLButtonElement>('.sessmem-panel__refresh')?.disabled).toBe(false)
  })

  it('distinguishes a measured-empty machine from a failed sweep', () => {
    mount({ ok: true, rows: [], loadedScope: '' })
    expect(text()).not.toContain('Could not measure')
    expect(text()).toContain('No sessions')
  })

  it('says nothing at all before the first sweep lands', () => {
    // `rows: []` with nothing loaded yet is not "there are no sessions" either.
    mount({ ok: true, rows: [], loadedScope: null, loading: true })
    expect(text()).not.toContain('No sessions')
    expect(text()).not.toContain('Could not measure')
    expect(text()).toContain('Measuring')
    // …and the header and footer have to stay silent too. `ok` is still TRUE in this state, so a
    // total or a count gated on `ok` instead of on "did we measure THIS machine" prints `0 B` /
    // `0 sessions` beside "Measuring…" — the same conflation, one state along.
    expect(host.querySelector('.sessmem-panel__total')).toBeNull()
    expect(text()).not.toContain('0 sessions')
    expect(text()).not.toMatch(/\d/)
  })

  it('disables the refresh and spins it while a sweep is in flight', () => {
    // A remote sweep is an ssh exec plus a `ps` on someone else's machine. Without this the user
    // can queue several by clicking, and nothing on screen says one is already running.
    mount({ loading: true })
    const refresh = host.querySelector<HTMLButtonElement>('.sessmem-panel__refresh')!
    expect(refresh.disabled).toBe(true)
    expect(refresh.classList.contains('spin')).toBe(true)
    act(() => refresh.click())
    expect(refreshFull).toHaveBeenCalledTimes(1) // the mount sweep, and nothing the click added
  })

  it('refuses to sweep with no active project — never through the api fallback', () => {
    // Unreachable from the pill today (it renders nothing without an active project), but this is
    // the one call that could fall through to the store's `activeSessionApi()`, which is the single
    // path able to address the wrong machine. The mount effect always guarded it; the ⟳ did not.
    useProjects.setState({ projects: [], activeProjectId: '' })
    mount()
    expect(refreshFull).not.toHaveBeenCalled()
    act(() => host.querySelector<HTMLButtonElement>('.sessmem-panel__refresh')!.click())
    expect(refreshFull).not.toHaveBeenCalled()
  })

  it('tells a relay tab it is unsupported here, not that the measurement failed', () => {
    // A relay tab's renderer runs on the guest while its sessions live on the host, so its
    // sessionMemory api is the ws-bridge stub: a permanent `ok:false`. That is the honest STUB
    // value and the wrong user-facing story — there is nothing to retry.
    useProjects.setState({
      projects: [project({ id: 'r1', name: 'Mac', remote: true })],
      activeProjectId: 'r1'
    })
    mount({ ok: false, rows: [], loadedScope: null })
    expect(text()).not.toContain('Could not measure')
    expect(text()).not.toContain('Measuring')
    expect(text()).toContain('relay')
    expect(host.querySelector('.sessmem-panel__refresh')).toBeNull()
    // No point sweeping a machine whose answer is a stub.
    expect(refreshFull).not.toHaveBeenCalled()
  })

  it('sweeps on open and on refresh, always naming the project', () => {
    mount()
    expect(refreshFull).toHaveBeenCalledTimes(1)
    // The project id is explicit: the store's `activeSessionApi()` fallback is the one path that
    // can address the wrong machine.
    expect(refreshFull).toHaveBeenCalledWith('', 'p1')
    act(() => host.querySelector<HTMLButtonElement>('.sessmem-panel__refresh')!.click())
    expect(refreshFull).toHaveBeenCalledTimes(2)
    expect(refreshFull).toHaveBeenLastCalledWith('', 'p1')
  })

  it('scopes the sweep and the header to an SSH project´s host', () => {
    useProjects.setState({
      projects: [
        project({
          id: 'ssh1',
          name: 'Box',
          ssh: { server: { host: 'box', user: 'enes', port: 22 } as never, remoteCwd: '/srv' }
        })
      ],
      activeProjectId: 'ssh1'
    })
    mount({ loadedScope: 'enes@box' })
    expect(refreshFull).toHaveBeenCalledWith('enes@box', 'ssh1')
    expect(host.querySelector('.sessmem-panel__scope')?.textContent).toBe('enes@box')
  })

  it('labels the local scope as this machine', () => {
    mount()
    expect(host.querySelector('.sessmem-panel__scope')?.textContent).toBe('This machine')
  })

  it('counts the sessions it is showing', () => {
    mount()
    expect(host.querySelector('.sessmem-panel__count')?.textContent).toBe('4 sessions')
  })

  // The feature's own premise: the user who prompted it blamed nodeterm for memory that is the
  // agent CLI's own V8 heap. Numbers rendered inside nodeterm's chrome with nothing said about
  // whose they are let this panel repeat the mistake it exists to correct, and that fact lived only
  // in the docs.
  it('says whose memory it is showing', () => {
    mount()
    const attrib = host.querySelector('.sessmem-panel__attrib')?.textContent ?? ''
    expect(attrib).toMatch(/not nodeterm/i)
  })

  it('says it in EVERY state, including a failed sweep', () => {
    // A failed measurement is exactly when a user is most likely to be blaming the wrong process,
    // so the line must not hang off the rows.
    mount({ ok: false, rows: [] })
    expect(host.querySelector('.sessmem-panel__note')?.textContent).toContain('Could not measure')
    expect(host.querySelector('.sessmem-panel__attrib')?.textContent ?? '').toMatch(/not nodeterm/i)
  })

  it('never touches the host poll — the pill owns that timer', () => {
    // `timer` and `activeScope` in the store are MODULE singletons. A `stopHostPoll` here would
    // clear the pill's interval on close with nothing left to restart it, and the pill's number
    // would freeze until the next scope change.
    mount()
    act(() => root.unmount())
    expect(startHostPoll).not.toHaveBeenCalled()
    expect(stopHostPoll).not.toHaveBeenCalled()
    root = createRoot(document.createElement('div'))
  })

  describe('pause control', () => {
    it('renders nothing in the slot for a row that cannot be paused', () => {
      // The default offer in this harness is `{show:false}` for every row, which is also the
      // pre-feature DOM — so every other test in this file asserts the unchanged panel.
      mount()
      expect(pauseOf(0)).toBeNull()
      expect(pauseOf(1)).toBeNull()
    })

    it('pauses the row it was clicked on, then re-sweeps so the freed memory shows', () => {
      pauseOffer = () => ({ show: true, disabled: false, hint: 'Pause session' })
      mount()
      refreshFull.mockClear()
      const btn = pauseOf(0)!
      act(() => btn.click())
      expect(onPauseSession).toHaveBeenCalledWith(ROWS[0].nodeId)
      // The sweep is what turns the action into a visible number; without it the row keeps
      // reporting the memory of a process that has just exited.
      return Promise.resolve().then(() => {
        expect(refreshFull).toHaveBeenCalled()
      })
    })

    it('does not fire for a disabled offer, even if the click gets through', () => {
      // `disabled` is the DOM's answer; the handler carries the code's, so a synthetic click (or a
      // browser that dispatches one anyway) cannot type `/exit` into a busy session.
      pauseOffer = () => ({ show: true, disabled: true, hint: 'This session is busy' })
      mount()
      const btn = pauseOf(0)!
      expect(btn.disabled).toBe(true)
      act(() => btn.click())
      expect(onPauseSession).not.toHaveBeenCalled()
    })

    it('carries the offer hint as the tooltip, so a refusal explains itself', () => {
      pauseOffer = () => ({ show: true, disabled: true, hint: 'Open this session on its canvas' })
      mount()
      expect(pauseOf(0)!.title).toBe('Open this session on its canvas')
    })

    it('draws the shared power icon, and the shared spinner while the pause is in flight', async () => {
      // The panel's pause is the SAME action as the node menu's "Pause session", which draws
      // `IconPower` — one action seen in two places must not speak in two voices.
      let settle = (): void => {}
      onPauseSession.mockImplementation(
        () =>
          new Promise<void>((res) => {
            settle = () => res()
          })
      )
      pauseOffer = () => ({ show: true, disabled: false, hint: 'Pause session' })
      mount()
      const btn = pauseOf(0)!
      expect(btn.querySelector('svg')).not.toBeNull()
      expect(btn.querySelector('.ui-spinner')).toBeNull()

      act(() => btn.click())
      expect(btn.querySelector('.ui-spinner')).not.toBeNull()
      expect(btn.querySelector('svg')).toBeNull()

      // Settle inside `act` so the icon is back before the test ends — a promise still pending at
      // teardown resolves into an unmounted tree.
      await act(async () => {
        settle()
      })
      expect(pauseOf(0)!.querySelector('svg')).not.toBeNull()
    })

    it('asks per row, so one row may offer a pause while another does not', () => {
      pauseOffer = (id) =>
        id === ROWS[0].nodeId
          ? { show: true, disabled: false, hint: 'Pause session' }
          : { show: false }
      mount()
      expect(pauseOf(0)).not.toBeNull()
      expect(pauseOf(1)).toBeNull()
    })
  })
})
