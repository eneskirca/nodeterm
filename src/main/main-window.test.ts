import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  setMainWindow,
  getMainWindow,
  sendToMain,
  mainWindowClientIds,
  shouldHideOnClose,
  closeAction,
  createCrashReloadPolicy,
  type MainWindowLike
} from './main-window'

function fakeWindow(): MainWindowLike & {
  sent: [string, ...unknown[]][]
  destroy(): void
  emitClosed(): void
} {
  let destroyed = false
  const closedListeners: (() => void)[] = []
  const sent: [string, ...unknown[]][] = []
  return {
    sent,
    isDestroyed: () => destroyed,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    on: (event: 'closed', cb: () => void) => {
      if (event === 'closed') closedListeners.push(cb)
    },
    webContents: {
      id: undefined as number | undefined,
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args])
      }
    },
    destroy() {
      destroyed = true
    },
    emitClosed() {
      closedListeners.forEach((cb) => cb())
    }
  }
}

describe('main-window tracking', () => {
  beforeEach(() => {
    // Reset module state between tests: register a fresh window then let it close.
    const w = fakeWindow()
    setMainWindow(w)
    w.destroy()
    w.emitClosed()
  })

  it('sendToMain delivers to the registered window', () => {
    const w = fakeWindow()
    setMainWindow(w)
    sendToMain('agent:status', { nodeId: 'n1' })
    expect(w.sent).toEqual([['agent:status', { nodeId: 'n1' }]])
  })

  it('sendToMain is a silent no-op once the window is destroyed', () => {
    const w = fakeWindow()
    setMainWindow(w)
    w.destroy()
    expect(() => sendToMain('agent:status', {})).not.toThrow()
    expect(w.sent).toEqual([])
    expect(getMainWindow()).toBeNull()
  })

  // The original bug: hook events were bound to the FIRST window via closure, so after
  // the macOS close→dock-reopen cycle every agent:status event was dropped forever.
  it('sendToMain reaches a replacement window registered after the first one died', () => {
    const first = fakeWindow()
    setMainWindow(first)
    first.destroy()
    first.emitClosed()

    const second = fakeWindow()
    setMainWindow(second)
    sendToMain('agent:status', { state: 'working' })

    expect(first.sent).toEqual([])
    expect(second.sent).toEqual([['agent:status', { state: 'working' }]])
    expect(getMainWindow()).toBe(second)
  })

  it("a stale 'closed' from the old window does not clear a newer registration", () => {
    const first = fakeWindow()
    setMainWindow(first)
    const second = fakeWindow()
    setMainWindow(second)
    first.emitClosed() // old window's closed event arrives late
    expect(getMainWindow()).toBe(second)
  })

  it('mainWindowClientIds returns the live window webContents id, or [] when there is none', () => {
    const w = fakeWindow()
    w.webContents.id = 7
    setMainWindow(w)
    expect(mainWindowClientIds()).toEqual([7])
    w.destroy()
    expect(mainWindowClientIds()).toEqual([])
  })

  it('getMainWindow returns null when nothing was registered or after closed', () => {
    const w = fakeWindow()
    setMainWindow(w)
    w.emitClosed()
    expect(getMainWindow()).toBeNull()
  })
})

// Field bug (2026-08-10): a dead renderer left the window permanently blank — the
// render-process-gone handler dropped pty clients but nothing ever reloaded the page.
describe('createCrashReloadPolicy', () => {
  it('reloads after a crashed renderer', () => {
    const onCrash = createCrashReloadPolicy()
    expect(onCrash('crashed', 0)).toBe('reload')
  })

  it('reloads after an OOM kill', () => {
    const onCrash = createCrashReloadPolicy()
    expect(onCrash('oom', 0)).toBe('reload')
  })

  it('ignores a clean exit and spends no reload budget on it', () => {
    const onCrash = createCrashReloadPolicy({ maxReloads: 1 })
    expect(onCrash('clean-exit', 0)).toBe('ignore')
    expect(onCrash('crashed', 1)).toBe('reload') // budget untouched
  })

  it('gives up when crashes keep coming inside the window (no reload loop)', () => {
    const onCrash = createCrashReloadPolicy({ maxReloads: 2, windowMs: 60_000 })
    expect(onCrash('crashed', 0)).toBe('reload')
    expect(onCrash('crashed', 1_000)).toBe('reload')
    expect(onCrash('crashed', 2_000)).toBe('give-up')
  })

  it('restores the budget once earlier reloads age out of the window', () => {
    const onCrash = createCrashReloadPolicy({ maxReloads: 2, windowMs: 60_000 })
    onCrash('crashed', 0)
    onCrash('crashed', 1_000)
    expect(onCrash('crashed', 2_000)).toBe('give-up')
    expect(onCrash('crashed', 61_500)).toBe('reload') // both grants aged out
  })
})

describe('shouldHideOnClose', () => {
  it('hides instead of closing on macOS while the app is not quitting', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(true)
  })
  it('lets the close through when the app is quitting', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false)
  })
  it('never intercepts close on other platforms', () => {
    expect(shouldHideOnClose('win32', false)).toBe(false)
    expect(shouldHideOnClose('linux', false)).toBe(false)
  })
  it('hides off macOS only in background mode, and never while quitting', () => {
    expect(shouldHideOnClose('win32', false, true)).toBe(true)
    expect(shouldHideOnClose('linux', false, true)).toBe(true)
    expect(shouldHideOnClose('win32', false, false)).toBe(false)
    expect(shouldHideOnClose('win32', true, true)).toBe(false)
  })
})

describe('closeAction', () => {
  it('hides a windowed macOS close', () => {
    expect(closeAction('darwin', false, false)).toBe('hide')
  })
  it('leaves fullscreen before hiding — hiding in place strands a black Space (issue #78)', () => {
    expect(closeAction('darwin', false, true)).toBe('leave-fullscreen-then-hide')
  })
  it('lets the close through when quitting, fullscreen or not', () => {
    expect(closeAction('darwin', true, true)).toBe('default')
    expect(closeAction('darwin', true, false)).toBe('default')
  })
  it('never intercepts on other platforms, fullscreen included', () => {
    expect(closeAction('linux', false, true)).toBe('default')
    expect(closeAction('win32', false, true)).toBe('default')
  })
  it('hides to the tray off macOS when background mode is on — plain hide, no Space dance', () => {
    expect(closeAction('win32', false, false, true)).toBe('hide')
    expect(closeAction('win32', false, true, true)).toBe('hide')
    expect(closeAction('linux', false, true, true)).toBe('hide')
  })
  it('lets the close through when quitting, background mode or not', () => {
    expect(closeAction('win32', true, false, true)).toBe('default')
    expect(closeAction('linux', true, true, true)).toBe('default')
  })
  it('macOS is unchanged by the background flag (it always hides)', () => {
    for (const bg of [false, true]) {
      expect(closeAction('darwin', false, false, bg)).toBe('hide')
      expect(closeAction('darwin', false, true, bg)).toBe('leave-fullscreen-then-hide')
      expect(closeAction('darwin', true, true, bg)).toBe('default')
    }
  })
})
