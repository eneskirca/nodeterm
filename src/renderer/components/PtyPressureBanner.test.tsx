// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PtyPressure, PtyLimitFixResult } from '@shared/types'
import { PtyPressureBanner, ptyPressureCopy } from './PtyPressureBanner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ptyPressureCopy', () => {
  it('names the two numbers and the way back, without shell instructions', () => {
    const copy = ptyPressureCopy({
      level: 'elevated',
      usage: 420,
      ceiling: 511
    })!
    expect(copy.body).toBe(
      'This machine is close to its terminal limit (420 of 511 pty devices). ' +
        'Deleting sessions from Recently closed returns them.'
    )
    expect(copy.body).not.toContain('sysctl')
  })

  it('says the terminals have ALREADY stopped opening once it is critical', () => {
    const copy = ptyPressureCopy({
      level: 'critical',
      usage: 509,
      ceiling: 511
    })!
    expect(copy.body).toContain('has run out of terminal capacity (509 of 511 pty devices)')
    expect(copy.body).toContain('New terminals will fail to open')
    expect(copy.body).toContain('Deleting sessions from Recently closed returns them.')
  })

  it('escalates the strip styling with the band', () => {
    expect(ptyPressureCopy({ level: 'elevated', usage: 420, ceiling: 511 })!.tone).toBe('warning')
    expect(ptyPressureCopy({ level: 'critical', usage: 509, ceiling: 511 })!.tone).toBe('danger')
  })

  it('has nothing to say at none, or when the numbers were never measured', () => {
    expect(ptyPressureCopy({ level: 'none', usage: 10, ceiling: 511 })).toBeNull()
    expect(ptyPressureCopy({ level: 'critical', usage: null, ceiling: null })).toBeNull()
  })
})

describe('PtyPressureBanner', () => {
  const reading = (level: PtyPressure['level']): PtyPressure => ({
    level,
    usage: 509,
    ceiling: 511
  })

  let listener: ((r: PtyPressure) => void) | null = null
  let fix: () => Promise<PtyLimitFixResult>

  beforeEach(() => {
    listener = null
    fix = vi.fn(async () => ({ ok: true as const, ceiling: 2048 }))
    ;(window as any).nodeTerminal = {
      onPtyPressure: (l: (r: PtyPressure) => void) => {
        listener = l
        return () => {
          listener = null
        }
      },
      raisePtyDeviceLimit: () => fix()
    }
  })

  const mount = (onError = vi.fn()) => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<PtyPressureBanner isMac onError={onError} />))
    return { host, root, onError }
  }

  it('shows nothing until the shell reports pressure', () => {
    const { host } = mount()
    expect(host.querySelector('.announce-banner')).toBeNull()
  })

  it('raises a warning banner with the fix button on macOS', () => {
    const { host } = mount()
    act(() => listener!(reading('elevated')))
    expect(host.textContent).toContain('509 of 511')
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain(
      'Fix automatically…'
    )
  })

  it('offers no fix button off macOS — only the informational text', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<PtyPressureBanner isMac={false} onError={vi.fn()} />))
    act(() => listener!(reading('critical')))
    expect(host.textContent).toContain('pty devices')
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Fix automatically…'
    )
  })

  it('a level that falls back to none takes the banner down, dismissal or not', () => {
    const { host } = mount()
    act(() => listener!(reading('critical')))
    expect(host.querySelector('.announce-banner')).not.toBeNull()
    act(() => listener!({ level: 'none', usage: 40, ceiling: 2048 }))
    expect(host.querySelector('.announce-banner')).toBeNull()
  })

  it('a dismissed ELEVATED banner stays down while the level holds, and returns when it worsens', () => {
    const { host } = mount()
    act(() => listener!(reading('elevated')))
    act(() => (host.querySelector('.announce-banner__close') as HTMLButtonElement).click())
    expect(host.querySelector('.announce-banner')).toBeNull()
    // A five-minute re-announce of the SAME early warning respects the dismissal — the user was
    // told, it is not urgent yet, and nagging is how a banner gets ignored for good.
    act(() => listener!(reading('elevated')))
    expect(host.querySelector('.announce-banner')).toBeNull()
    act(() => listener!(reading('critical')))
    expect(host.querySelector('.announce-banner')).not.toBeNull()
  })

  it('a dismissed CRITICAL banner comes back on the next re-announce', () => {
    const { host } = mount()
    act(() => listener!(reading('critical')))
    act(() => (host.querySelector('.announce-banner__close') as HTMLButtonElement).click())
    expect(host.querySelector('.announce-banner')).toBeNull()
    // The shell re-announces a held critical every five minutes. Terminals are failing to open
    // right now: a dismissal buys quiet until the next reminder, never permanent silence.
    act(() => listener!(reading('critical')))
    expect(host.querySelector('.announce-banner')).not.toBeNull()
  })

  it('the fix button invokes ONCE and reports nothing on success (the re-broadcast clears it)', async () => {
    const { host, onError } = mount()
    act(() => listener!(reading('critical')))
    const btn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Fix automatically…'
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(fix).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('a cancelled password dialog is silent — no toast, no retry loop', async () => {
    fix = vi.fn(async () => ({
      ok: false as const,
      canceled: true,
      error: 'Cancelled'
    }))
    const { host, onError } = mount()
    act(() => listener!(reading('critical')))
    const btn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Fix automatically…'
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onError).not.toHaveBeenCalled()
    expect(host.querySelector('.announce-banner')).not.toBeNull() // banner stays
  })

  it('a busy answer is silent too — another window is already holding the dialog', async () => {
    fix = vi.fn(async () => ({ ok: false as const, busy: true, error: 'Already asking' }))
    const { host, onError } = mount()
    act(() => listener!(reading('critical')))
    const btn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Fix automatically…'
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onError).not.toHaveBeenCalled()
  })

  it('a real failure goes to the caller error surface', async () => {
    fix = vi.fn(async () => ({ ok: false as const, error: 'sysctl exploded' }))
    const { host, onError } = mount()
    act(() => listener!(reading('critical')))
    const btn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Fix automatically…'
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onError).toHaveBeenCalledWith('sysctl exploded')
  })
})
