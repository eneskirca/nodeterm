import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { PtyManager } from './pty-manager'

const host = vi.hoisted(() => ({ supported: vi.fn(() => false) }))
vi.mock('./session-host-backend', () => ({ sessionHostSupported: host.supported }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

describe('local persistence discovery (#575)', () => {
  beforeEach(() => { initPlatform(fakePlatform()); host.supported.mockReturnValue(false) })
  afterEach(() => { vi.restoreAllMocks(); resetPlatformForTests() })

  function manager(platform: NodeJS.Platform, tmux: boolean, enabled = true): PtyManager {
    const mgr = new PtyManager({ runtimePlatform: platform })
    // Isolate discovery from the real machine, config writes and running tmux servers.
    Object.assign(mgr, { tmuxPath: tmux ? '/fixture/tmux' : null, getSettings: () => ({ tmuxEnabled: enabled }) })
    vi.spyOn(mgr, 'ensureTmux').mockImplementation(() => {})
    return mgr
  }

  it.each(['win32', 'linux', 'darwin'] as const)('reports missing and newly available host on %s', (os) => {
    const mgr = manager(os, false)
    expect(mgr.tmuxStatus()).toMatchObject({ platform: os, persistence: { enabled: true, backend: null } })
    host.supported.mockReturnValue(true)
    expect(mgr.tmuxStatus().persistence).toEqual({ enabled: true, backend: 'session-host' })
  })
  it('prefers tmux on POSIX, without even probing the host', () => {
    host.supported.mockClear()
    expect(manager('darwin', true).tmuxStatus().persistence?.backend).toBe('tmux')
    expect(host.supported).not.toHaveBeenCalled()
  })
  it('never treats a Windows tmux path as protection', () => {
    expect(manager('win32', true).tmuxStatus().persistence?.backend).toBeNull()
  })
  it('keeps the user setting distinct from backend discovery', () => {
    host.supported.mockReturnValue(true)
    expect(manager('win32', false, false).tmuxStatus().persistence).toEqual({ enabled: false, backend: 'session-host' })
    expect(manager('linux', true, false).tmuxStatus().persistence).toEqual({ enabled: false, backend: 'tmux' })
  })
})
