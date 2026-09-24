// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxStatus } from '@shared/types'
const mock = vi.hoisted(() => ({ read: vi.fn(), enabled: true }))
vi.mock('../session/localSession', () => ({ localSession: { api: { pty: { tmuxStatus: mock.read } } } }))
vi.mock('../state/settings', () => ({ useSettings: (select: (s: unknown) => unknown) => select({ settings: { tmuxEnabled: mock.enabled } }) }))
import { TmuxBanner } from './TmuxBanner'
import { persistenceDescription } from './usePersistenceStatus'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const status = (backend: 'tmux' | 'session-host' | null, enabled = true, platform = 'win32'): TmuxStatus => ({
  available: backend === 'tmux', platform, installCommand: null, installLabel: null, persistence: { enabled, backend }
})
afterEach(() => { vi.useRealTimers(); mock.read.mockReset(); mock.enabled = true })

describe('session protection notice', () => {
  it.each([['win32', null], ['linux', null], ['darwin', null], ['win32', 'session-host'], ['linux', 'session-host'], ['darwin', 'tmux']] as const)(
    '%s / %s renders the actual backend availability', async (platform, backend) => {
      mock.read.mockResolvedValue(status(backend, true, platform))
      const el = document.createElement('div'); const root = createRoot(el)
      try {
        await act(async () => root.render(<TmuxBanner onInstall={vi.fn()} />))
        expect(el.textContent?.includes('No session protection backend')).toBe(backend === null)
        if (backend) expect(el.textContent).toBe('')
      } finally { await act(async () => root.unmount()) }
    }
  )
  it('refreshes after discovery changes, and warns on a failed read', async () => {
    vi.useFakeTimers()
    mock.read.mockResolvedValue(status(null))
    const el = document.createElement('div'); const root = createRoot(el)
    try {
      await act(async () => root.render(<TmuxBanner onInstall={vi.fn()} />))
      expect(el.textContent).toContain('will not survive')
      mock.read.mockResolvedValue(status('session-host'))
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(el.textContent).toBe('')
      mock.read.mockRejectedValue(new Error('offline'))
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(el.textContent).toContain('could not be checked')
    } finally { await act(async () => root.unmount()) }
  })
  it('offers installation only when the caller supplies a local route; tracks completion', async () => {
    vi.useFakeTimers()
    const missing = { ...status(null, true, 'linux'), installCommand: 'fixture-install', installLabel: 'Install tmux' }
    mock.read.mockResolvedValue(missing)
    const onInstall = vi.fn()
    const el = document.createElement('div'); const root = createRoot(el)
    try {
      await act(async () => root.render(<TmuxBanner />))
      expect(el.querySelector('.announce-banner__btn')).toBeNull()
      await act(async () => root.render(<TmuxBanner onInstall={onInstall} />))
      await act(async () => (el.querySelector('.announce-banner__btn') as HTMLButtonElement).click())
      expect(onInstall).toHaveBeenCalledWith('fixture-install')
      expect(el.textContent).toContain('Installing tmux')
      mock.read.mockResolvedValue(status('tmux', true, 'linux'))
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(el.textContent).toContain('Existing plain-shell terminals are not upgraded')
    } finally { await act(async () => root.unmount()) }
  })
  it('disabled protection warns even with a backend; dismisses only the notice', async () => {
    mock.read.mockResolvedValue(status('session-host', false))
    const el = document.createElement('div'); const root = createRoot(el)
    try {
      await act(async () => root.render(<TmuxBanner onInstall={vi.fn()} />))
      expect(el.textContent).toContain('Session protection off')
      expect(el.querySelector('.announce-banner__btn')).toBeNull()
      await act(async () => (el.querySelector('.announce-banner__close') as HTMLButtonElement).click())
      expect(el.textContent).toBe('')
      expect(mock.enabled).toBe(true)
    } finally { await act(async () => root.unmount()) }
  })
  it('does not confuse disabled, unknown or older peers with available protection', () => {
    expect(persistenceDescription(status('session-host', false))).toContain('is off')
    expect(persistenceDescription(null)).toContain('not confirmed')
    expect(persistenceDescription({ ...status(null), persistence: undefined })).toContain('not confirmed')
    expect(persistenceDescription(status('session-host'))).toContain('runtime startup can still fail')
  })
})
