// @vitest-environment jsdom
// The update card's wiring: quiet automatic downloads, user-initiated progress, the ready card's
// install-on-quit copy + Later, the restart feedback, and the periodic policy re-read. The state
// rules themselves are pinned in lib/updateCardState.test.ts.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateCard, POLICY_REFRESH_MS, POLICY_RETRY_MS } from './UpdateCard'
import { usePendingUpdate } from '../state/pendingUpdate'
import { LAST_SEEN_VERSION_KEY } from '../lib/releaseNotes'
import type { UpdatePolicy } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Fire = (...a: unknown[]) => void
const fire: Record<string, Fire> = {}
const sub = (name: string) => (listener: Fire) => {
  fire[name] = listener
  return () => delete fire[name]
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let policies: Array<UpdatePolicy | Error>
let version: string
let staged: { version: string; notes: string } | null
const restart = vi.fn()
const check = vi.fn()

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(<UpdateCard />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const k of Object.keys(fire)) delete fire[k]
  restart.mockClear()
  check.mockClear()
  policies = []
  version = '0.5.0'
  staged = null
  usePendingUpdate.setState({ pending: null })
  try {
    window.localStorage.clear()
  } catch {
    /* no storage */
  }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    updates: {
      onAvailable: sub('available'),
      onDownloaded: sub('downloaded'),
      onProgress: sub('progress'),
      onError: sub('error'),
      onNotAvailable: sub('notAvailable'),
      onNoChannel: sub('noChannel'),
      onInstalling: sub('installing'),
      getVersion: () => Promise.resolve(version),
      getStaged: () => Promise.resolve(staged),
      getPolicy: vi.fn(() => {
        const next = policies.shift() ?? { minSupported: null, mandatory: false }
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
      }),
      check,
      restart,
      prepareInspect: () => Promise.resolve({ kind: 'unsupported' }),
      prepareShutdownHost: () => Promise.resolve({ kind: 'unsupported' }),
      prepareQuit: () => {}
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const text = (): string => container.textContent ?? ''
const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('automatic downloads are quiet', () => {
  beforeEach(mount)

  it('an automatic available renders nothing — no card, no pill', () => {
    act(() => fire.available({ version: '0.6.0', notes: '', manual: false }))
    act(() => fire.progress({ percent: 40 }))
    expect(text()).toBe('')
  })

  it('the finished download opens the ready card and fills the title-bar button', () => {
    act(() => fire.available({ version: '0.6.0', notes: '', manual: false }))
    act(() => fire.downloaded({ version: '0.6.0' }))
    expect(text()).toContain('Update ready')
    expect(usePendingUpdate.getState().pending).toEqual({ kind: 'downloaded', version: '0.6.0' })
  })

  it('a user check shows progress, and that card can be closed', () => {
    act(() => window.dispatchEvent(new CustomEvent('nodeterm:update-checking')))
    act(() => fire.available({ version: '0.6.0', notes: '', manual: false }))
    act(() => fire.progress({ percent: 25 }))
    expect(text()).toContain('Downloading… 25%')
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click())
    expect(text()).toBe('')
    act(() => fire.downloaded({ version: '0.6.0' }))
    expect(text()).toContain('Update ready')
  })

  it('a manual-delivery payload (check-only build) still opens its card', () => {
    act(() => fire.available({ version: '0.6.0', notes: '', manual: true }))
    expect(text()).toContain('nodeterm v0.6.0 is available. Download it to update.')
  })

  it('an automatic "up to date" says nothing', () => {
    act(() => fire.notAvailable())
    expect(text()).toBe('')
  })
})

describe('the ready card', () => {
  beforeEach(() => {
    mount()
    act(() => fire.downloaded({ version: '0.6.0', notes: '- Faster canvas\n- Fewer prompts' }))
  })

  it('says it installs on quit, shows highlights, and offers Later', () => {
    expect(text()).toContain('It installs automatically the next time you quit.')
    expect(text()).toContain('Faster canvas')
    expect(text()).toContain('Fewer prompts')
    act(() => button('Later')!.click())
    expect(text()).toContain('Ready')
    expect(text()).not.toContain('Update ready')
    expect(restart).not.toHaveBeenCalled()
  })

  it('Restart → a disabled Preparing… button, then Restarting… from main', () => {
    act(() => button('Restart to update')!.click())
    expect(restart).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Preparing update…')
    const busy = container.querySelector<HTMLButtonElement>('button[disabled]')
    expect(busy?.textContent).toContain('Preparing…')
    act(() => fire.installing({ phase: 'restarting', version: '0.6.0' }))
    expect(text()).toContain('Restarting nodeterm…')
    expect(container.querySelector<HTMLButtonElement>('button[disabled]')?.textContent).toContain('Restarting…')
  })

  it('an install failure returns to the ready card with the reason', () => {
    act(() => button('Restart to update')!.click())
    act(() => fire.installing({ phase: 'preparing', version: '0.6.0' }))
    act(() => fire.error('Code signature did not pass validation'))
    expect(text()).toContain('Update ready')
    expect(text()).toContain('Code signature did not pass validation')
    expect(button('Restart to update')).toBeTruthy()
  })

  it('a repeat downloaded for the same version does not re-open a minimized card', () => {
    act(() => button('Later')!.click())
    act(() => fire.downloaded({ version: '0.6.0' }))
    expect(text()).not.toContain('Update ready')
  })
})

describe('the mandatory policy is re-read', () => {
  it('retries once after an empty first read, then every six hours', async () => {
    policies = [
      { minSupported: null, mandatory: false },
      { minSupported: '0.1.0', mandatory: false },
      { minSupported: '0.9.0', mandatory: true }
    ]
    mount()
    await flush()
    const getPolicy = (window as unknown as { nodeTerminal: { updates: { getPolicy: ReturnType<typeof vi.fn> } } })
      .nodeTerminal.updates.getPolicy
    expect(getPolicy).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(POLICY_RETRY_MS)
    })
    await flush()
    expect(getPolicy).toHaveBeenCalledTimes(2)
    expect(text()).toBe('')
    await act(async () => {
      vi.advanceTimersByTime(POLICY_REFRESH_MS)
    })
    await flush()
    expect(getPolicy).toHaveBeenCalledTimes(3)
    expect(text()).toContain('Update required')
    expect(text()).toContain('minimum 0.9.0')
  })

  it('a failed first read is retried too', async () => {
    policies = [new Error('offline'), { minSupported: '0.9.0', mandatory: true }]
    mount()
    await flush()
    expect(text()).toBe('')
    await act(async () => {
      vi.advanceTimersByTime(POLICY_RETRY_MS)
    })
    await flush()
    expect(text()).toContain('Update required')
  })
})

describe('updated to vX', () => {
  it('announces the first launch of a newer version once', async () => {
    window.localStorage.setItem(LAST_SEEN_VERSION_KEY, '0.4.3')
    mount()
    await flush()
    expect(text()).toContain('Updated to v0.5.0')
    act(() => root.unmount())
    container.remove()
    mount()
    await flush()
    expect(text()).not.toContain('Updated to')
  })

  it('stays silent on a fresh install', async () => {
    mount()
    await flush()
    expect(text()).toBe('')
    expect(window.localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe('0.5.0')
  })
})

describe('a renderer that loads after the one-time announcement', () => {
  it('asks main for the staged update and shows the ready card (⌘R / recreated window)', async () => {
    staged = { version: '0.6.0', notes: '- Faster restarts' }
    mount()
    await flush()
    expect(text()).toContain('Update ready')
    expect(text()).toContain('Faster restarts')
    expect(usePendingUpdate.getState().pending).toEqual({ kind: 'downloaded', version: '0.6.0' })
  })

  it('nothing staged: stays silent', async () => {
    mount()
    await flush()
    expect(text()).toBe('')
  })
})
