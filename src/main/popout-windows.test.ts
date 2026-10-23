import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainWindow, type MainWindowLike } from './main-window'
import {
  appWindowContents,
  detachedProjectIds,
  isAppWindow,
  menuTarget,
  onDetachedChange,
  popoutClientIds,
  popoutForProject,
  popoutProjectOf,
  registerPopout,
  resetPopoutsForTests,
  saveScopeFor,
  sendToAppWindows,
  windowShowingProject,
  type PopoutWindowLike
} from './popout-windows'

function fakeWindow(id: number): PopoutWindowLike & MainWindowLike & {
  sent: [string, ...unknown[]][]
  emitClosed(): void
  destroy(): void
} {
  let destroyed = false
  const closed: (() => void)[] = []
  const sent: [string, ...unknown[]][] = []
  return {
    sent,
    isDestroyed: () => destroyed,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    on: (event: 'closed', cb: () => void) => {
      if (event === 'closed') closed.push(cb)
    },
    webContents: {
      id,
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args])
      }
    },
    emitClosed() {
      destroyed = true
      for (const cb of closed) cb()
    },
    destroy() {
      destroyed = true
    }
  }
}

beforeEach(() => resetPopoutsForTests())
afterEach(() => resetPopoutsForTests())

describe('pop-out registry', () => {
  it('tracks a pop-out until its window closes, and reports every change', () => {
    const seen: string[][] = []
    onDetachedChange((ids) => seen.push(ids))
    const b = fakeWindow(20)
    registerPopout('b', b)
    expect(detachedProjectIds()).toEqual(['b'])
    expect(popoutForProject('b')).toBe(b)
    expect(popoutProjectOf(20)).toBe('b')
    expect(popoutClientIds()).toEqual([20])
    b.emitClosed()
    expect(detachedProjectIds()).toEqual([])
    expect(popoutForProject('b')).toBeNull()
    expect(popoutProjectOf(20)).toBeNull()
    expect(seen).toEqual([['b'], []])
  })

  it('a late closed from a replaced window does not unregister its successor', () => {
    const first = fakeWindow(20)
    const second = fakeWindow(21)
    registerPopout('b', first)
    registerPopout('b', second)
    first.emitClosed()
    expect(popoutForProject('b')).toBe(second)
    expect(popoutClientIds()).toEqual([21])
  })

  it('a destroyed-but-not-yet-closed window is already not a pop-out', () => {
    const b = fakeWindow(20)
    registerPopout('b', b)
    b.destroy()
    expect(popoutForProject('b')).toBeNull()
    expect(detachedProjectIds()).toEqual([])
    expect(popoutClientIds()).toEqual([])
  })
})

describe('save scope by sender', () => {
  it('a pop-out owns its project; every other sender owns everything but the popped-out ones', () => {
    registerPopout('b', fakeWindow(20))
    registerPopout('c', fakeWindow(21))
    expect(saveScopeFor(20)).toEqual({ kind: 'popout', projectId: 'b' })
    expect(saveScopeFor(1)).toEqual({ kind: 'main', detached: ['b', 'c'] })
    expect(saveScopeFor(1_000_001)).toEqual({ kind: 'main', detached: ['b', 'c'] }) // a relay peer
  })

  it('with no pop-out open the main scope owns everything', () => {
    expect(saveScopeFor(1)).toEqual({ kind: 'main', detached: [] })
  })
})

describe('window routing', () => {
  it('sends per-node channels to the main window AND every live pop-out', () => {
    const main = fakeWindow(1)
    setMainWindow(main)
    const b = fakeWindow(20)
    const c = fakeWindow(21)
    registerPopout('b', b)
    registerPopout('c', c)
    c.destroy()
    sendToAppWindows('agent:status', { nodeId: 'n' })
    expect(main.sent).toEqual([['agent:status', { nodeId: 'n' }]])
    expect(b.sent).toEqual([['agent:status', { nodeId: 'n' }]])
    expect(c.sent).toEqual([])
  })

  it('resolves the window showing a project: its pop-out, else the main window', () => {
    const main = fakeWindow(1)
    setMainWindow(main)
    const b = fakeWindow(20)
    registerPopout('b', b)
    expect(windowShowingProject('b')).toBe(b)
    expect(windowShowingProject('a')).toBe(main)
    expect(windowShowingProject(undefined)).toBe(main)
    b.emitClosed()
    expect(windowShowingProject('b')).toBe(main)
  })
})

describe('menu target', () => {
  it('menu commands go to the focused app window, else the main window', () => {
    const main = fakeWindow(1)
    setMainWindow(main)
    const b = fakeWindow(20)
    registerPopout('b', b)
    const devtools = fakeWindow(99)
    expect(menuTarget(b, main)).toBe(b)
    expect(menuTarget(main, main)).toBe(main)
    expect(menuTarget(devtools, main)).toBe(main)
    expect(menuTarget(null, main)).toBe(main)
  })
})

describe('appWindowContents / isAppWindow', () => {
  it('lists the main window first, then every live pop-out, so a flush reaches each renderer', () => {
    const main = fakeWindow(1)
    setMainWindow(main)
    const a = fakeWindow(2)
    const b = fakeWindow(3)
    registerPopout('pa', a)
    registerPopout('pb', b)
    b.destroy()
    const contents = appWindowContents()
    expect(contents.map((c) => c.id)).toEqual([1, 2])
    contents[1].send('app:flush-request', 'x')
    expect(a.sent).toEqual([['app:flush-request', 'x']])
    expect(contents[1].isDestroyed()).toBe(false)
    a.destroy()
    expect(contents[1].isDestroyed()).toBe(true)
  })

  it('an app window is the main window or a pop-out, never another webContents', () => {
    const main = fakeWindow(1)
    setMainWindow(main)
    const pop = fakeWindow(2)
    registerPopout('p', pop)
    expect(isAppWindow(main)).toBe(true)
    expect(isAppWindow(pop)).toBe(true)
    expect(isAppWindow(fakeWindow(9))).toBe(false) // DevTools, the notch HUD
    expect(isAppWindow(null)).toBe(false)
  })
})
