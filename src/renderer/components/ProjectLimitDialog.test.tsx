// @vitest-environment jsdom
//
// The limit dialog (docs/project-limit.md, The limit moment). The open gate
// (lib/projectLimitGate.ts) holds a promise for every dialog it shows and refuses every other open
// while that promise is pending, so the one rule above all others here: EVERY way out of the dialog
// goes through `resolveDialog`. A dialog that vanishes any other way (or stays unsettled behind an
// unmounted component) latches every later at-limit open to `false` for the rest of the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '@shared/types'
import type { ProjectLimitState } from '@shared/project-limit'

// The project-limit store subscribes to `window.nodeTerminal.projectLimit.onChange` when it is
// created, so the bridge must exist before any import runs.
const h = vi.hoisted(() => {
  const upgrade = vi.fn(async () => {})
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    projectLimit: { state: vi.fn(), claim: vi.fn(), onChange: () => () => {} }
  }
  return { upgrade }
})
// The real stores pull in the whole workspace / license bridge; the dialog only reads the project
// list and calls `upgrade`.
vi.mock('../state/projects', async () => {
  const { create } = await import('zustand')
  return { useProjects: create(() => ({ projects: [] })) }
})
vi.mock('../state/entitlement', async () => {
  const { create } = await import('zustand')
  return { useEntitlement: create(() => ({ upgrade: h.upgrade })) }
})

import { ProjectLimitDialog } from './ProjectLimitDialog'
import { useProjects } from '../state/projects'
import {
  setProjectLimitChecking,
  showProjectLimitDialog,
  useProjectLimit,
  type DialogOutcome,
  type LimitDialogRequest
} from '../state/projectLimit'
import { INACTIVE_PROJECT_LIMIT } from '@shared/project-limit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AT_LIMIT: ProjectLimitState = { active: true, pro: false, free: 5, allowance: 5, dnt: false }
/** No allowance claimed yet (the claim failed): at the limit this decides `claim`, not `allow`. */
const UNCLAIMED: ProjectLimitState = { ...AT_LIMIT, allowance: null }

function project(id: string, over: Partial<Project> = {}): Project {
  return { id, name: `Project ${id}`, color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over }
}

/** Five open projects, plus a relay tab and a closed project — neither of which ever counts. */
const PROJECTS: Project[] = [
  project('p1'),
  project('p2'),
  project('p3'),
  project('p4'),
  project('p5'),
  project('relay', { name: 'Host tab', remote: true }),
  project('gone', { name: 'Closed one', closed: true })
]

let root: Root
let host: HTMLElement
let onCloseProject: ReturnType<typeof vi.fn<(id: string) => void>>
let mounted = false

function mount(): void {
  root = createRoot(host)
  act(() => root.render(<ProjectLimitDialog onCloseProject={onCloseProject} />))
  mounted = true
}

function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}

function show(request: LimitDialogRequest): Promise<DialogOutcome> {
  let pending!: Promise<DialogOutcome>
  act(() => {
    pending = showProjectLimitDialog(request)
  })
  return pending
}

function box(): HTMLElement | null {
  return document.querySelector('.confirm')
}

function text(): string {
  return box()?.textContent ?? ''
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.confirm button')]
}

function button(label: string): HTMLButtonElement {
  const el = buttons().find((b) => b.textContent === label)
  if (!el) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(' | ')}`)
  return el
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.confirm li')]
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  onCloseProject = vi.fn<(id: string) => void>()
  h.upgrade.mockClear()
  useProjects.setState({ projects: PROJECTS })
  useProjectLimit.setState({ state: AT_LIMIT, checking: false })
  mount()
})

afterEach(() => {
  // A test that leaves a dialog up must not strand its promise for the next one.
  useProjectLimit.getState().resolveDialog('cancel')
  unmount()
  host.remove()
  useProjectLimit.setState({ state: INACTIVE_PROJECT_LIMIT, dialog: null, checking: false })
})

describe('ProjectLimitDialog — limit mode', () => {
  it('says how many of the allowance are open', () => {
    void show({ mode: 'limit' })
    expect(text()).toContain('5 of 5 free projects are open')
    expect(text()).toContain(
      'Close one to make room. Closing never deletes anything — its terminals keep running and it stays one click away in Recently closed.'
    )
  })

  it('counts against the allowance, not FREE', () => {
    act(() => useProjectLimit.setState({ state: { ...AT_LIMIT, allowance: 7 } }))
    act(() =>
      useProjects.setState({
        projects: [...PROJECTS, project('p6'), project('p7')]
      })
    )
    void show({ mode: 'limit' })
    expect(text()).toContain('7 of 7 free projects are open')
  })

  it('lists every open project and never a relay tab or a closed project', () => {
    void show({ mode: 'limit' })
    const listed = rows().map((r) => r.textContent ?? '')
    expect(listed).toHaveLength(5)
    expect(listed.map((t) => t.replace(/Close$/, ''))).toEqual([
      'Project p1',
      'Project p2',
      'Project p3',
      'Project p4',
      'Project p5'
    ])
    expect(text()).not.toContain('Host tab')
    expect(text()).not.toContain('Closed one')
  })

  it('Close calls onCloseProject with that project, and leaves the dialog to the open count', () => {
    void show({ mode: 'limit' })
    const row = rows().find((r) => r.textContent?.startsWith('Project p3'))!
    click(row.querySelector('button')!)
    expect(onCloseProject).toHaveBeenCalledTimes(1)
    expect(onCloseProject).toHaveBeenCalledWith('p3')
  })

  it('a Close that makes room resolves proceed', async () => {
    onCloseProject.mockImplementation((id) => {
      useProjects.setState({
        projects: useProjects.getState().projects.map((p) => (p.id === id ? { ...p, closed: true } : p))
      })
    })
    const pending = show({ mode: 'limit' })
    click(rows()[0].querySelector('button')!)
    await expect(pending).resolves.toBe('proceed')
    expect(useProjectLimit.getState().dialog).toBeNull()
    expect(box()).toBeNull()
  })

  it('a Close that still leaves it over the limit keeps the dialog up, with the new count', () => {
    act(() => useProjects.setState({ projects: [...PROJECTS, project('p6')] }))
    onCloseProject.mockImplementation((id) => {
      useProjects.setState({
        projects: useProjects.getState().projects.map((p) => (p.id === id ? { ...p, closed: true } : p))
      })
    })
    void show({ mode: 'limit' })
    expect(text()).toContain('6 of 5 free projects are open')
    click(rows()[0].querySelector('button')!)
    expect(useProjectLimit.getState().dialog).not.toBeNull()
    expect(text()).toContain('5 of 5 free projects are open')
  })

  it('Pro arriving through the license broadcast resolves proceed', async () => {
    const pending = show({ mode: 'limit' })
    act(() => useProjectLimit.setState({ state: { ...AT_LIMIT, pro: true } }))
    await expect(pending).resolves.toBe('proceed')
    expect(box()).toBeNull()
  })

  it('resolves proceed exactly once, however many pushes follow', async () => {
    const original = useProjectLimit.getState().resolveDialog
    const calls: DialogOutcome[] = []
    useProjectLimit.setState({
      resolveDialog: (outcome) => {
        calls.push(outcome)
        original(outcome)
      }
    })
    try {
      const pending = show({ mode: 'limit' })
      act(() => useProjectLimit.setState({ state: { ...AT_LIMIT, pro: true } }))
      act(() => useProjectLimit.setState({ state: { ...AT_LIMIT, pro: true, free: 6 } }))
      act(() => useProjects.setState({ projects: PROJECTS.slice(0, 3) }))
      await expect(pending).resolves.toBe('proceed')
      expect(calls).toEqual(['proceed'])
    } finally {
      useProjectLimit.setState({ resolveDialog: original })
    }
  })

  it('the Pro button starts the checkout and does not close the dialog by itself', () => {
    void show({ mode: 'limit' })
    click(button('Unlimited with Pro — $10/mo'))
    expect(h.upgrade).toHaveBeenCalledTimes(1)
    expect(useProjectLimit.getState().dialog).not.toBeNull()
  })

  it('Cancel resolves cancel', async () => {
    const pending = show({ mode: 'limit' })
    click(button('Cancel'))
    await expect(pending).resolves.toBe('cancel')
    expect(box()).toBeNull()
  })

  it('an overlay click resolves cancel; a click inside the box does not', async () => {
    const pending = show({ mode: 'limit' })
    click(box()!)
    expect(useProjectLimit.getState().dialog).not.toBeNull()
    click(document.querySelector('.confirm-overlay')!)
    await expect(pending).resolves.toBe('cancel')
  })

  it('Escape resolves cancel', async () => {
    const pending = show({ mode: 'limit' })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(pending).resolves.toBe('cancel')
  })

  it('shows no Retry and no allowance notice when nothing failed', () => {
    void show({ mode: 'limit' })
    expect(buttons().some((b) => b.textContent === 'Retry')).toBe(false)
    expect(text()).not.toContain("Couldn't check")
    expect(text()).not.toContain('another computer')
  })

  it('is portaled to the body on the dialog overlay, so it sits over the kanban board', () => {
    void show({ mode: 'limit' })
    const overlay = document.querySelector('.confirm-overlay')!
    expect(overlay.parentElement).toBe(document.body)
    expect(host.contains(overlay)).toBe(false)
  })
})

describe('ProjectLimitDialog — error and mismatch', () => {
  it('error: says the allowance could not be checked and Retry resolves retry', async () => {
    act(() => useProjectLimit.setState({ state: UNCLAIMED }))
    const pending = show({ mode: 'error' })
    expect(text()).toContain('5 of 5 free projects are open')
    expect(text()).toContain("Couldn't check your free allowance with api.nodeterm.dev.")
    // Close and Pro still work: a failed check never takes the ways out away.
    expect(rows()).toHaveLength(5)
    expect(button('Unlimited with Pro — $10/mo')).toBeTruthy()
    click(button('Retry'))
    await expect(pending).resolves.toBe('retry')
  })

  it('error: a Close that makes room still resolves proceed', async () => {
    act(() => useProjectLimit.setState({ state: UNCLAIMED }))
    const pending = show({ mode: 'error' })
    act(() => useProjects.setState({ projects: PROJECTS.slice(1) }))
    await expect(pending).resolves.toBe('proceed')
  })

  it('mismatch: says the allowance is tied to another computer, with the date it can move', () => {
    const retryAfter = 1_800_000_000
    act(() => useProjectLimit.setState({ state: UNCLAIMED }))
    void show({ mode: 'mismatch', retryAfter })
    expect(text()).toContain('5 of 5 free projects are open')
    expect(text()).toContain(
      `Your free allowance is tied to another computer. It can move to this one on ${new Date(retryAfter * 1000).toLocaleDateString()}.`
    )
    expect(rows()).toHaveLength(5)
  })

  it('mismatch without a date never prints an invalid one', () => {
    act(() => useProjectLimit.setState({ state: UNCLAIMED }))
    void show({ mode: 'mismatch' })
    expect(text()).toContain('Your free allowance is tied to another computer.')
    expect(text()).not.toContain('Invalid Date')
    expect(text()).not.toContain('It can move')
  })
})

describe('ProjectLimitDialog — consent', () => {
  it('shows the connection copy, with no project list and no Pro button', () => {
    void show({ mode: 'consent' })
    expect(text()).toContain('Connection needed')
    expect(text()).toContain(
      'Checking your free allowance and upgrading need a connection to api.nodeterm.dev. Only license checks are sent — telemetry stays off. You can turn this off in Settings → Privacy.'
    )
    expect(rows()).toHaveLength(0)
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Allow and check'])
  })

  it('Allow and check resolves consent', async () => {
    const pending = show({ mode: 'consent' })
    click(button('Allow and check'))
    await expect(pending).resolves.toBe('consent')
  })

  it('Cancel resolves cancel', async () => {
    const pending = show({ mode: 'consent' })
    click(button('Cancel'))
    await expect(pending).resolves.toBe('cancel')
  })

  it('is never resolved automatically: the user has to answer it', () => {
    void show({ mode: 'consent' })
    act(() => useProjectLimit.setState({ state: { ...AT_LIMIT, pro: true } }))
    expect(useProjectLimit.getState().dialog).toEqual({ mode: 'consent' })
    expect(text()).toContain('Connection needed')
  })
})

describe('ProjectLimitDialog — checking and lifecycle', () => {
  it('renders nothing with no dialog and no claim in flight', () => {
    expect(document.querySelector('.confirm-overlay')).toBeNull()
  })

  it('while a claim is in flight, shows the checking panel with no buttons', () => {
    act(() => setProjectLimitChecking(true))
    expect(text()).toBe('Checking your free allowance…')
    expect(buttons()).toHaveLength(0)
    act(() => setProjectLimitChecking(false))
    expect(box()).toBeNull()
  })

  it('a dialog replaces the checking panel', () => {
    act(() => setProjectLimitChecking(true))
    void show({ mode: 'limit' })
    expect(document.querySelectorAll('.confirm')).toHaveLength(1)
    expect(text()).not.toContain('Checking your free allowance…')
  })

  it('unmounting while a dialog is open resolves cancel, so the gate is never left waiting', async () => {
    const pending = show({ mode: 'limit' })
    unmount()
    await expect(pending).resolves.toBe('cancel')
    expect(useProjectLimit.getState().dialog).toBeNull()
  })

  it('a new request after one was answered is a fresh dialog', async () => {
    const first = show({ mode: 'limit' })
    click(button('Cancel'))
    await expect(first).resolves.toBe('cancel')
    const second = show({ mode: 'error' })
    expect(text()).toContain("Couldn't check your free allowance")
    click(button('Retry'))
    await expect(second).resolves.toBe('retry')
  })
})
