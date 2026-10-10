// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    color: '#0a84ff',
    cwd: '/repo/alpha',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    ...over
  }
}

async function load(): Promise<{
  TabBar: typeof import('./TabBar').TabBar
  useProjects: typeof import('../state/projects').useProjects
}> {
  const { TabBar } = await import('./TabBar')
  const { useProjects } = await import('../state/projects')
  return { TabBar, useProjects }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', memStorage())
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver
  Element.prototype.scrollIntoView = (): void => {}
  ;(window as unknown as { nodeTerminal: Record<string, never> }).nodeTerminal = {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('TabBar caret menu', () => {
  let root: Root
  let host: HTMLElement
  let onOpenProjectSettings: ReturnType<typeof vi.fn<(id: string) => void>>

  const menuButton = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-menu button')).find(
      (b) => b.textContent?.trim() === label
    )

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    onOpenProjectSettings = vi.fn<(id: string) => void>()
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={onOpenProjectSettings}
        />
      )
    })
    await click(host.querySelector<HTMLButtonElement>('.tab__caret')!)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('offers "Project settings…" and deep-links the project it was opened on', async () => {
    const item = menuButton('Project settings…')
    expect(item).toBeDefined()
    await click(item!)
    expect(onOpenProjectSettings).toHaveBeenCalledWith('p1')
    // …and the menu closes behind it, like every other action in this menu.
    expect(document.querySelector('.tab-menu')).toBeNull()
  })

  it('closes on a press anywhere outside it, including the bar the menu hangs from', async () => {
    // The dismiss backdrop is below the bar so a click on another tab still switches projects,
    // which leaves the bar itself unable to close the menu without this.
    expect(document.querySelector('.tab-menu')).not.toBeNull()
    await act(async () => {
      host
        .querySelector('.tabbar')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('.tab-menu')).toBeNull()
  })

  it('leaves the caret to its own toggle, so pressing it while open does not reopen the menu', async () => {
    const caret = host.querySelector<HTMLButtonElement>('.tab__caret')!
    await act(async () => {
      caret.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('.tab-menu')).not.toBeNull()
    await click(caret)
    expect(document.querySelector('.tab-menu')).toBeNull()
  })
})
describe('TabBar New-project pin', () => {
  let root: Root
  let host: HTMLElement
  let onOpenWelcome: ReturnType<typeof vi.fn<() => void>>

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({
      projects: [
        project({ id: 'p1', name: 'One' }),
        project({ id: 'p2', name: 'Two' }),
        project({ id: 'p3', name: 'Three' }),
        project({ id: 'p4', name: 'Four' })
      ],
      activeProjectId: 'p1'
    })
    onOpenWelcome = vi.fn()
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={onOpenWelcome}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
        />
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('keeps the + outside the scrolling tab strip', () => {
    const add = host.querySelector('.tab__add')
    const scroller = host.querySelector('.tabbar__tabs')
    expect(add).toBeTruthy()
    expect(scroller).toBeTruthy()
    expect(scroller!.contains(add)).toBe(false)
    expect(host.querySelector('.tabbar__projects')!.contains(add)).toBe(true)
  })

  it('opens the start screen from +', async () => {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.tab__add')!.click()
    })
    expect(onOpenWelcome).toHaveBeenCalledTimes(1)
  })
})

describe('TabBar drag-reorder', () => {
  let root: Root
  let host: HTMLElement
  let onReorder: ReturnType<typeof vi.fn<(dragged: string, before: string | null) => void>>

  // jsdom has no DragEvent, and React reads `dataTransfer` in onDragStart. One shared stub is
  // enough: nothing here inspects what was put on it.
  const drag = async (el: Element, type: string): Promise<void> => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', { value: { effectAllowed: '', setData: (): void => {} } })
    await act(async () => {
      el.dispatchEvent(e)
    })
  }

  const tabs = (): Element[] => Array.from(host.querySelectorAll('.tab'))

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({
      projects: [
        project(),
        project({ id: 'p2', name: 'Beta', cwd: '/repo/beta' }),
        project({ id: 'p3', name: 'Gamma', cwd: '/repo/gamma' })
      ],
      activeProjectId: 'p1'
    })
    onReorder = vi.fn<(dragged: string, before: string | null) => void>()
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={onReorder}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
        />
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('drops a tab before the one it was released on', async () => {
    const [first, , third] = tabs()
    await drag(third, 'dragstart')
    await drag(first, 'dragover')
    await drag(first, 'drop')
    expect(onReorder).toHaveBeenCalledWith('p3', 'p1')
  })

  it('marks the hovered tab so the insertion line has something to hang on', async () => {
    const [first, , third] = tabs()
    await drag(third, 'dragstart')
    await drag(first, 'dragover')
    expect(first.classList.contains('is-drop-before')).toBe(true)
  })

  it('shows an insertion line for the end zone, which has no tab to hang one off', async () => {
    const [first] = tabs()
    await drag(first, 'dragstart')
    expect(host.querySelector('.tab__dropline')).toBeNull()
    await drag(host.querySelector('.tabbar__tabs')!, 'dragover')
    expect(host.querySelector('.tab__dropline')).not.toBeNull()
  })

  it('drops at the end when released on the strip itself', async () => {
    const [first] = tabs()
    await drag(first, 'dragstart')
    await drag(host.querySelector('.tabbar__tabs')!, 'dragover')
    await drag(host.querySelector('.tabbar__tabs')!, 'drop')
    expect(onReorder).toHaveBeenCalledWith('p1', null)
  })
})

describe('TabBar options button', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({
      projects: [project(), project({ id: 'p2', name: 'Beta' })],
      activeProjectId: 'p1'
    })
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
        />
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('sits on every tab, so the menu is reachable without activating it first', () => {
    expect(host.querySelectorAll('.tab__caret').length).toBe(2)
  })

  it('opens the menu for the tab it belongs to, active or not', async () => {
    const inactive = host.querySelectorAll<HTMLButtonElement>('.tab__caret')[1]
    await act(async () => {
      inactive.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.querySelector('.tab-menu')).not.toBeNull()
  })
})


describe('TabBar Share with team', () => {
  let root: Root
  let host: HTMLElement
  let onShareWithTeam: ReturnType<typeof vi.fn<(id: string) => void>>

  const SSH = { server: { host: 'box', user: 'alice' }, remoteCwd: '~/proj' }
  const shareRow = (): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-menu button')).find(
      (b) => b.textContent?.trim() === 'Share with team…'
    )

  async function open(
    over: Partial<Project>,
    props: { share?: boolean; blocked?: (id: string) => string | null } = {}
  ): Promise<void> {
    const { TabBar, useProjects } = await load()
    useProjects.setState({ projects: [project(over)], activeProjectId: 'p1' })
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
          {...(props.share === false ? {} : { onShareWithTeam })}
          shareBlockedReason={props.blocked}
        />
      )
    })
    await click(host.querySelector<HTMLButtonElement>('.tab__caret')!)
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    onShareWithTeam = vi.fn<(id: string) => void>()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('shows for an SSH project, and opens the share for it', async () => {
    await open({ ssh: SSH })
    const row = shareRow()
    expect(row).toBeDefined()
    expect(row!.disabled).toBe(false)
    await click(row!)
    expect(onShareWithTeam).toHaveBeenCalledWith('p1')
    expect(document.querySelector('.tab-menu')).toBeNull()
  })

  it('is absent for a local project, a relay tab and when the canvas offers no share', async () => {
    await open({})
    expect(shareRow()).toBeUndefined()
    act(() => root.unmount())
    root = createRoot(host)
    await open({ ssh: SSH, remote: true })
    expect(shareRow()).toBeUndefined()
    act(() => root.unmount())
    root = createRoot(host)
    await open({ ssh: SSH }, { share: false })
    expect(shareRow()).toBeUndefined()
  })

  it('is disabled with the reason while the share is blocked', async () => {
    const reason = 'Connect this project first (its SSH connection is down).'
    await open({ ssh: SSH }, { blocked: () => reason })
    const row = shareRow()!
    expect(row.disabled).toBe(true)
    expect(row.title).toBe(reason)
    await click(row)
    expect(onShareWithTeam).not.toHaveBeenCalled()
  })
})

describe('TabBar location tooltip', () => {
  let root: Root
  let host: HTMLElement

  const tooltip = (): HTMLElement | null => document.querySelector<HTMLElement>('.tooltip')
  const tab = (name: string): HTMLElement =>
    Array.from(host.querySelectorAll<HTMLElement>('.tab')).find(
      (t) => t.querySelector('.tab__name')?.textContent === name
    )!

  // React synthesises onMouseEnter/onMouseLeave from the delegated mouseover/mouseout events.
  const hover = (el: HTMLElement): void =>
    act(() => {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
  const leave = (el: HTMLElement): void =>
    act(() => {
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
  const dwell = (ms: number): void =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })

  beforeEach(async () => {
    const { TabBar, useProjects } = await load()
    // The tooltip asks which session a tab belongs to; the app always has the local one.
    const session = await import('../session/session')
    session.setActiveSession(session.createSession('local', window.nodeTerminal, 'local').id)
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({
      projects: [
        project({ id: 'p1', name: 'Alpha', cwd: '/repo/alpha' }),
        project({
          id: 'p2',
          name: 'Remote',
          cwd: undefined,
          ssh: { server: { user: 'root', host: 'box.example' }, remoteCwd: '/srv/app' }
        }),
        project({ id: 'p3', name: 'Scratch', cwd: undefined })
      ],
      activeProjectId: 'p1'
    })
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
        />
      )
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    host.remove()
  })

  it("shows a local project's folder once the pointer rests on its tab, and not before", () => {
    hover(tab('Alpha'))
    dwell(400)
    expect(tooltip()).toBeNull()
    dwell(100)
    expect(tooltip()?.textContent).toBe('/repo/alpha')
  })

  it('carries no native title, so the OS does not draw a second tooltip over it', () => {
    expect(tab('Alpha').hasAttribute('title')).toBe(false)
  })

  it('hides when the pointer leaves, or presses the tab', () => {
    hover(tab('Alpha'))
    dwell(500)
    expect(tooltip()).not.toBeNull()
    leave(tab('Alpha'))
    expect(tooltip()).toBeNull()

    hover(tab('Alpha'))
    dwell(500)
    act(() => {
      tab('Alpha').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(tooltip()).toBeNull()
  })

  it('names the host for an SSH project', () => {
    hover(tab('Remote'))
    dwell(500)
    expect(tooltip()?.textContent).toBe('root@box.example:/srv/app')
  })

  it('shows nothing for a canvas with no folder', () => {
    hover(tab('Scratch'))
    dwell(1000)
    expect(tooltip()).toBeNull()
  })
})

describe('TabBar caret menu — "Agents may, without asking" (per-project confirm waivers)', () => {
  let root: Root
  let host: HTMLElement
  let useSettings: typeof import('../state/settings').useSettings

  const menuButton = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-menu button')).find((b) =>
      // A group row's text carries its ▸ caret, an item row's a leading ✓ — match the label.
      (b.textContent ?? '').replace('▸', '').trim().endsWith(label)
    )
  const waivers = (): unknown => useSettings.getState().settings.controlConfirmWaivers

  async function mount(over: Partial<Project> = {}, seed?: unknown): Promise<void> {
    const { TabBar, useProjects } = await load()
    useSettings = (await import('../state/settings')).useSettings
    // update() schedules a coalesced save through the bridge; give it somewhere to land.
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      settings: { save: vi.fn(async () => undefined) }
    }
    useSettings.setState((s) => ({
      settings: { ...s.settings, controlConfirmWaivers: seed as never }
    }))
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({ projects: [project(over)], activeProjectId: 'p1' })
    root = createRoot(host)
    await act(async () => {
      root.render(
        <TabBar
          onSwitch={vi.fn()}
          onReconnect={vi.fn()}
          onReorder={vi.fn()}
          onOpenWelcome={vi.fn()}
          onRename={vi.fn()}
          onSetFolder={vi.fn()}
          onCloseProject={vi.fn()}
          onRemoteAccess={vi.fn()}
          onSetDefaultAccount={vi.fn()}
          onSetDefaultPermissionMode={vi.fn()}
          onOpenProjectSettings={vi.fn()}
        />
      )
    })
    await click(host.querySelector<HTMLButtonElement>('.tab__caret')!)
  }

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('asks by default: every row is unchecked until the user opts in', async () => {
    await mount()
    await click(menuButton('Agents may, without asking')!)
    for (const label of ['Close nodes', 'Type into terminals', 'Open or add projects']) {
      const row = menuButton(label)
      expect(row, label).toBeDefined()
      expect(row!.querySelector('.tab-menu__check')!.textContent).toBe('')
    }
  })

  it('waives close for THIS project only, machine-locally, and turns it back off', async () => {
    await mount()
    await click(menuButton('Agents may, without asking')!)
    await click(menuButton('Close nodes')!)
    // The same settings.json map the dialog's "Don't ask again for agents in …" writes.
    expect(waivers()).toEqual({ projects: { p1: ['close'] } })
    // The menu stays open so several rows can be set in one visit, and the row shows its state.
    expect(menuButton('Close nodes')!.querySelector('.tab-menu__check')!.textContent).toBe('✓')
    expect(menuButton('Type into terminals')!.querySelector('.tab-menu__check')!.textContent).toBe('')
    await click(menuButton('Close nodes')!)
    expect(waivers()).toEqual({})
  })

  it('shows a machine-wide waiver as on, but sends the user to Settings to change it', async () => {
    await mount({}, { always: ['close'] })
    await click(menuButton('Agents may, without asking')!)
    const row = menuButton('Close nodes')!
    expect(row.disabled).toBe(true)
    expect(row.title).toContain('Settings → Agents')
    expect(row.querySelector('.tab-menu__check')!.textContent).toBe('✓')
  })

  it('offers nothing on a relay tab — that machine owns its agents’ confirms', async () => {
    await mount({ remote: { peerId: 'x' } as never })
    expect(menuButton('Agents may, without asking')).toBeUndefined()
  })

  it('offers nothing in the browser Server Edition, where these waivers gate nothing', async () => {
    ;(await import('../bridge/runtime')).markBrowserRuntime()
    await mount()
    expect(menuButton('Agents may, without asking')).toBeUndefined()
  })

  it('shows an app-run waiver as in effect and never promises a dialog it would not raise', async () => {
    await mount()
    const { useControlConfirm } = await import('../state/controlConfirm')
    await act(async () => useControlConfirm.getState().waiveForSession('close'))
    await click(menuButton('Agents may, without asking')!)
    const row = menuButton('Close nodes')!
    expect(row.querySelector('.tab-menu__check')!.textContent).toBe('✓')
    expect(row.disabled).toBe(true)
    expect(row.title).toContain('until nodeterm quits')
    expect(row.title).not.toContain('ask you first')
  })

  it('under global Bypass, removing the project grant says the dialog still will not come', async () => {
    await mount({}, { projects: { p1: ['close'] }, bypassMode: true })
    await act(async () =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, claudePermissionMode: 'bypassPermissions' }
      }))
    )
    await click(menuButton('Agents may, without asking')!)
    const row = menuButton('Close nodes')!
    expect(row.disabled).toBe(false)
    expect(row.title).toContain('Bypass')
    expect(row.title).not.toContain('Click to ask again')
    await click(row)
    // The project grant is gone, the gate still skips — and the row says why.
    expect(waivers()).toEqual({ bypassMode: true })
    const after = menuButton('Close nodes')!
    expect(after.querySelector('.tab-menu__check')!.textContent).toBe('✓')
    expect(after.disabled).toBe(true)
  })
})
