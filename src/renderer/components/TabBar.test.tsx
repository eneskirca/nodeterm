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
          onPopOut={vi.fn()}
          onClosePopout={vi.fn()}
          onReturnToMain={vi.fn()}
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
          onPopOut={vi.fn()}
          onClosePopout={vi.fn()}
          onReturnToMain={vi.fn()}
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
          onPopOut={vi.fn()}
          onClosePopout={vi.fn()}
          onReturnToMain={vi.fn()}
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
          onPopOut={vi.fn()}
          onClosePopout={vi.fn()}
          onReturnToMain={vi.fn()}
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


describe('TabBar pop-out windows', () => {
  let root: Root
  let host: HTMLElement

  async function render(props: Partial<React.ComponentProps<typeof import('./TabBar').TabBar>> = {}) {
    const { TabBar } = await load()
    host = document.createElement('div')
    document.body.appendChild(host)
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
          onPopOut={vi.fn()}
          onClosePopout={vi.fn()}
          onReturnToMain={vi.fn()}
          onOpenProjectSettings={vi.fn()}
          {...props}
        />
      )
    })
  }

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const names = () => [...host.querySelectorAll('.tab__name')].map((n) => n.textContent)

  it('a ghosted tab: marked, not draggable, click brings its window forward, menu offers only window actions', async () => {
    const { useProjects } = await load()
    const { useWindows } = await import('../state/windows')
    useProjects.setState({ projects: [project(), project({ id: 'p2', name: 'Beta' })], activeProjectId: 'p1' })
    useWindows.getState().setDetached(['p2'])
    const onSwitch = vi.fn()
    const onClosePopout = vi.fn()
    await render({ onSwitch, onClosePopout })
    const tabs = host.querySelectorAll<HTMLElement>('.tab')
    expect(tabs[1].classList.contains('detached')).toBe(true)
    expect(tabs[1].draggable).toBe(false)
    expect(tabs[1].querySelector('.tab__popout')).not.toBeNull()
    expect(tabs[0].querySelector('.tab__popout')).toBeNull()
    await click(tabs[1])
    expect(onSwitch).toHaveBeenCalledWith('p2') // Canvas routes a detached id to focusProject
    await click(tabs[1].querySelector<HTMLButtonElement>('.tab__caret')!)
    const rows = [...document.querySelectorAll('.tab-menu button')].map((b) => b.textContent)
    expect(rows).toEqual(['Show window', 'Bring back to this window'])
    await click(document.querySelectorAll<HTMLButtonElement>('.tab-menu button')[1])
    expect(onClosePopout).toHaveBeenCalledWith('p2')
  })

  it('an ordinary tab offers "Open in new window" in its menu', async () => {
    const onPopOut = vi.fn()
    const { useProjects } = await load()
    useProjects.setState({ projects: [project()], activeProjectId: 'p1' })
    await render({ onPopOut })
    await click(host.querySelector<HTMLButtonElement>('.tab__caret')!)
    const row = [...document.querySelectorAll<HTMLButtonElement>('.tab-menu button')].find(
      (b) => b.textContent === 'Open in new window'
    )
    expect(row).toBeDefined()
    await click(row!)
    expect(onPopOut).toHaveBeenCalledWith('p1')
  })

  it('inside a pop-out: only its project, no +, a way back, and the menu closes the window instead of the project', async () => {
    const { useProjects } = await load()
    const { useWindows } = await import('../state/windows')
    useProjects.setState({ projects: [project(), project({ id: 'p2', name: 'Beta' })], activeProjectId: 'p2' })
    useWindows.setState({ popoutProjectId: 'p2' })
    const onReturnToMain = vi.fn()
    const onCloseProject = vi.fn()
    await render({ onReturnToMain, onCloseProject })
    expect(names()).toEqual(['Beta'])
    expect(host.querySelector('.tab__add')).toBeNull()
    expect(host.querySelector<HTMLElement>('.tab')!.draggable).toBe(false)
    await click(host.querySelector<HTMLButtonElement>('.tab__return')!)
    expect(onReturnToMain).toHaveBeenCalled()
    await click(host.querySelector<HTMLButtonElement>('.tab__caret')!)
    const rows = [...document.querySelectorAll('.tab-menu button')].map((b) => b.textContent)
    expect(rows).not.toContain('Open in new window')
    expect(rows).not.toContain('Close project')
    expect(rows).toContain('Back to main window')
  })

  it('dragging a tab off the strip (released below it) tears it off; a reorder does not', async () => {
    const { useProjects } = await load()
    useProjects.setState({ projects: [project(), project({ id: 'p2', name: 'Beta' })], activeProjectId: 'p1' })
    const onPopOut = vi.fn()
    const onReorder = vi.fn()
    await render({ onPopOut, onReorder })
    const [alpha, beta] = host.querySelectorAll<HTMLElement>('.tab')
    const strip = host.querySelector<HTMLElement>('.tabbar')!
    strip.getBoundingClientRect = () => ({ top: 0, bottom: 40, left: 0, right: 1200, width: 1200, height: 40, x: 0, y: 0, toJSON: () => ({}) })
    // jsdom has no DragEvent: a MouseEvent carries the release point, and `dataTransfer` is stubbed
    // the way the reorder suite above stubs it.
    const drag = (target: HTMLElement, type: string, init: MouseEventInit) =>
      act(async () => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
        Object.defineProperty(e, 'dataTransfer', { value: { effectAllowed: '', setData: (): void => {} } })
        target.dispatchEvent(e)
      })
    // Released on the canvas, well below the strip → tear-off.
    await drag(alpha, 'dragstart', {})
    await drag(alpha, 'dragend', { clientX: 300, clientY: 400 })
    expect(onPopOut).toHaveBeenCalledWith('p1')
    expect(onReorder).not.toHaveBeenCalled()
    // A drop on another tab → reorder, and NOT a tear-off even though dragend follows.
    onPopOut.mockClear()
    await drag(alpha, 'dragstart', {})
    await drag(beta, 'dragover', { clientX: 200, clientY: 20 })
    await drag(beta, 'drop', { clientX: 200, clientY: 20 })
    await drag(alpha, 'dragend', { clientX: 200, clientY: 20 })
    expect(onReorder).toHaveBeenCalledWith('p1', 'p2')
    expect(onPopOut).not.toHaveBeenCalled()
  })
})
