// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MemInfo, Project } from '@shared/types'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import { useSessionMemory } from '../state/sessionMemory'
import { SystemResourcePill } from './SystemResourcePill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'p',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

const sshProject = (): Project =>
  project({ id: 'ssh1', ssh: { server: { host: 'box', user: 'enes', port: 22 } as never, remoteCwd: '/srv' } })

/**
 * The FIXTURE is the whole test. `used = totalMb - availableMb` must be distinguishable from every
 * other number in the object, or a component that printed `availableMb` (or `totalMb`) would pass:
 * total 64000, available 48000 ⇒ used 16000, and 15.6 / 46.9 / 62.5 GB are three different strings.
 */
const MEM: MemInfo = { totalMb: 64000, availableMb: 48000 }

let host: HTMLDivElement
let root: Root
let startHostPoll: Mock<(scopeKey: string, projectId?: string) => void>
let stopHostPoll: Mock<() => void>
let refreshFull: Mock<(scopeKey: string, projectId?: string) => Promise<void>>

/** Mount with the store's actions stubbed — the real ones would talk to a session registry that
 *  does not exist in a jsdom test, and `refreshHost` would clear the `mem` fixture on the way
 *  through `enterScope`.
 *
 *  `refreshFull` is stubbed for a different reason: it must be OBSERVABLE. The real one swallows
 *  every failure, so a future edit that put the full process-table sweep on this pill's 30 s timer
 *  would leave the suite green and show no symptom — while costing an ssh exec plus a remote `ps`
 *  every 30 seconds on an SSH scope. */
function mount(mem: MemInfo | null, overBoard = false): void {
  useSessionMemory.setState({ mem, startHostPoll, stopHostPoll, refreshFull })
  host = document.createElement('div')
  root = createRoot(host)
  act(() =>
    root.render(
      <SystemResourcePill overBoard={overBoard} onGoToNode={vi.fn()} onKillSession={vi.fn()} />
    )
  )
}

beforeEach(() => {
  startHostPoll = vi.fn<(scopeKey: string, projectId?: string) => void>()
  stopHostPoll = vi.fn<() => void>()
  refreshFull = vi.fn<(scopeKey: string, projectId?: string) => Promise<void>>(async () => {})
  useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
  useSshConn.setState({ byProject: {} })
})

afterEach(() => {
  act(() => root.unmount())
})

describe('SystemResourcePill', () => {
  it('renders used / total, never the available or total figure alone', () => {
    mount(MEM)
    const pill = host.querySelector('.sysres-pill')
    expect(pill?.textContent).toContain('15.6 GB')
    expect(pill?.textContent).toContain('62.5 GB')
    expect(pill?.textContent).not.toContain('46.9 GB')
  })

  it('keeps the numbers in the DOM at rest — the reveal is CSS, not a mount', () => {
    // The collapsed pill is icon-only, but the detail must still exist: it carries the button's
    // accessible name, and a hover-mounted number would be unreachable to a screen reader and to
    // anything that reads the control without pointing at it.
    mount(MEM)
    const detail = host.querySelector('.sysres-pill__detail')
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toContain('15.6 GB')
  })

  it('tints the icon by memory USED, not by what is free', () => {
    // The icon carries the pressure reading now that the bar is gone. 25% used is calm; the same
    // machine read as 75% FREE would be the danger tint, which is the mistake this pins.
    mount(MEM)
    expect(host.querySelector<HTMLElement>('.sysres-pill__icon')?.style.color).toBe('')
    act(() => root.unmount())
    // 63 of 64 GB used — the same machine read as "98% free" would stay calm, which is the
    // direction this pins.
    mount({ totalMb: 64000, availableMb: 1000 })
    expect(host.querySelector<HTMLElement>('.sysres-pill__icon')?.style.color).toBe('var(--danger)')
  })

  it('pulses instead of claiming a number when the reading is null', () => {
    mount(null)
    const pill = host.querySelector('.sysres-pill')
    expect(pill).not.toBeNull()
    expect(host.querySelector('.sysres-pill__pulse')).not.toBeNull()
    // The one thing this pill must never say. `0 GB` is the shape a confident zero takes, but so
    // is any digit at all — there is no number we are entitled to print without a reading.
    expect(pill?.textContent).not.toMatch(/\d/)
    expect(pill?.textContent).not.toContain('GB')
  })

  it('treats a zero total as unreadable rather than dividing by it', () => {
    mount({ totalMb: 0, availableMb: 0 })
    expect(host.querySelector('.sysres-pill__pulse')).not.toBeNull()
    expect(host.querySelector('.sysres-pill')?.textContent).not.toMatch(/\d/)
  })

  it('starts the host poll for the active project and stops it on unmount', () => {
    mount(MEM)
    expect(startHostPoll).toHaveBeenCalledTimes(1)
    // Explicit project id — the store's `activeSessionApi()` fallback is the only path that can
    // address the wrong machine.
    expect(startHostPoll).toHaveBeenCalledWith('', 'p1')
    act(() => root.unmount())
    expect(stopHostPoll).toHaveBeenCalledTimes(1)
    // The afterEach unmount must not throw on an already-unmounted root.
    root = createRoot(document.createElement('div'))
  })

  it('polls an SSH project under its HOST key, never the local scope', () => {
    useProjects.setState({ projects: [sshProject()], activeProjectId: 'ssh1' })
    mount(MEM)
    expect(startHostPoll).toHaveBeenCalledWith('enes@box', 'ssh1')
  })

  it('re-reads when the SSH project connection comes up', () => {
    useProjects.setState({ projects: [sshProject()], activeProjectId: 'ssh1' })
    mount(MEM)
    expect(startHostPoll).toHaveBeenCalledTimes(1)
    // An SSH scope is read ONCE with no timer behind it, so a first read that landed before the
    // ControlMaster was up would leave the pill blank until the panel was opened.
    act(() => {
      useSshConn.setState({ byProject: { ssh1: { controlPath: '/tmp/cm' } } })
    })
    expect(startHostPoll).toHaveBeenCalledTimes(2)
    expect(startHostPoll).toHaveBeenLastCalledWith('enes@box', 'ssh1')
    // The connect-up path is the likeliest place for someone to "just also refresh the rows".
    expect(refreshFull).not.toHaveBeenCalled()
  })

  it('never runs the full sweep itself — the cheap read is the pill´s, the expensive one the panel´s', () => {
    // `refreshFull` walks the whole process table, and on an SSH scope that is an ssh exec plus a
    // remote `ps`. On this component's 30 s timer that would be a background cost nobody asked for,
    // and the real action swallows its failures, so it would show no symptom at all.
    mount(MEM)
    expect(refreshFull).not.toHaveBeenCalled()
    // Clicking sweeps exactly once, and the call comes from the MOUNTED PANEL — never from a
    // second caller here that a later timer could be attached to. (The sweep-on-open contract
    // itself is pinned in SessionMemoryPanel.test.tsx.)
    act(() => host.querySelector<HTMLButtonElement>('.sysres-pill')!.click())
    expect(host.querySelector('.sessmem-panel')).not.toBeNull()
    expect(refreshFull).toHaveBeenCalledTimes(1)
    // Closing unmounts the panel, so nothing keeps sweeping behind it.
    act(() => host.querySelector<HTMLButtonElement>('.sysres-pill')!.click())
    expect(host.querySelector('.sessmem-panel')).toBeNull()
    expect(refreshFull).toHaveBeenCalledTimes(1)
  })

  it('renders nothing and polls nothing without an active project', () => {
    useProjects.setState({ projects: [], activeProjectId: '' })
    mount(MEM)
    expect(host.querySelector('.sysres-pill')).toBeNull()
    expect(startHostPoll).not.toHaveBeenCalled()
  })

  it('rises above the kanban overlay only when the board is open', () => {
    mount(MEM, true)
    expect(host.querySelector('.sysres-indicator--board')).not.toBeNull()
    act(() => root.unmount())
    mount(MEM, false)
    expect(host.querySelector('.sysres-indicator--board')).toBeNull()
  })

  it('toggles its open state — the pill is the panel´s only entry point', () => {
    mount(MEM)
    const pill = host.querySelector<HTMLButtonElement>('.sysres-pill')!
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    act(() => pill.click())
    expect(host.querySelector('.sysres-pill')?.getAttribute('aria-expanded')).toBe('true')
    act(() => host.querySelector<HTMLButtonElement>('.sysres-pill')!.click())
    expect(host.querySelector('.sysres-pill')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on an outside click, but not on the kill confirm', () => {
    mount(MEM)
    document.body.appendChild(host)
    act(() => host.querySelector<HTMLButtonElement>('.sysres-pill')!.click())
    expect(host.querySelector('.sessmem-panel')).not.toBeNull()

    // The `×` raises a ConfirmDialog through a portal OUTSIDE this container. Answering it must not
    // dismiss the list the user is working through.
    const confirm = document.createElement('div')
    confirm.className = 'confirm-overlay'
    document.body.appendChild(confirm)
    act(() => confirm.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(host.querySelector('.sessmem-panel')).not.toBeNull()

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(host.querySelector('.sessmem-panel')).toBeNull()
    confirm.remove()
    host.remove()
  })

  it('announces a region that actually exists', () => {
    // `aria-expanded` on its own told assistive tech about an expandable region and expanded
    // nothing. It may only ship pointing at the real panel.
    mount(MEM)
    const pill = host.querySelector<HTMLButtonElement>('.sysres-pill')!
    const controls = pill.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(host.querySelector(`#${controls}`)).toBeNull()
    act(() => pill.click())
    const panel = host.querySelector(`#${controls}`)
    expect(panel).not.toBeNull()
    expect(panel?.classList.contains('sessmem-panel')).toBe(true)
  })
})
