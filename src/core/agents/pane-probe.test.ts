import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { probeWithin, PANE_PROBE_TIMEOUT_MS } from './pane-probe'

describe('probeWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers the value when the read finishes in time', async () => {
    await expect(probeWithin(async () => 'claude', 1000)).resolves.toBe('claude')
  })

  it('answers null at the deadline when the read never finishes', async () => {
    const p = probeWithin(() => new Promise<string>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void p.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false) // still waiting — the bound is a deadline, not a poll
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBeNull()
  })

  it('answers null when the read throws, rather than rejecting into the main process', async () => {
    await expect(
      probeWithin(async () => {
        throw new Error('ssh: connection closed')
      }, 1000)
    ).resolves.toBeNull()
  })

  it('answers null when the read rejects asynchronously too', async () => {
    await expect(probeWithin(() => Promise.reject(new Error('EPIPE')), 1000)).resolves.toBeNull()
  })

  it('gives each call its own deadline — a slow one does not shorten the next', async () => {
    const slow = probeWithin(() => new Promise<string>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(900)
    const second = probeWithin(() => new Promise<string>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(100)
    await expect(slow).resolves.toBeNull()

    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(secondSettled).toBe(false) // 900ms of its own 1000 still to run
    await vi.advanceTimersByTimeAsync(900)
    await expect(second).resolves.toBeNull()
  })

  it('does not hold a timer open after a fast answer', async () => {
    await expect(probeWithin(async () => 42, 60_000)).resolves.toBe(42)
    // A live 60s timer here would keep the process (and, under fake timers, the suite) waiting.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defaults to the gate deadline, which is bounded in seconds not minutes', async () => {
    const p = probeWithin(() => new Promise<string>(() => {}))
    await vi.advanceTimersByTimeAsync(PANE_PROBE_TIMEOUT_MS)
    await expect(p).resolves.toBeNull()
    expect(PANE_PROBE_TIMEOUT_MS).toBe(2000)
  })
})

describe('WINDOWS_PANE_PROBE_TIMEOUT_MS covers the Windows probe it bounds (#1211)', () => {
  // A messaging read reaches `readWindowsConsoleOwner`, which asks this process's long-lived probe
  // worker (#1206) and falls back to a one-shot powershell.exe when the worker cannot answer. The
  // worker idles out after a minute, so a message sent minutes after the last one meets a COLD
  // worker: its first-request deadline (PowerShell startup + Add-Type) and, if that lapses, the
  // one-shot run. An outer budget below that sum discards the answer that was on its way and reads
  // a healthy pane as `targetPaneUnreadable`.
  it('is above the cold-worker deadline plus the one-shot fallback', async () => {
    const { WINDOWS_PANE_PROBE_TIMEOUT_MS } = await import('./pane-probe')
    const { PROBE_FIRST_REQUEST_TIMEOUT_MS, WINDOWS_ONESHOT_PROBE_TIMEOUT_MS } = await import(
      '../../session-host/windows-probe-budget'
    )
    expect(WINDOWS_PANE_PROBE_TIMEOUT_MS).toBeGreaterThan(
      PROBE_FIRST_REQUEST_TIMEOUT_MS + WINDOWS_ONESHOT_PROBE_TIMEOUT_MS
    )
  })

  it('stays a real bound, above the tmux/ssh one', async () => {
    // The outer bound only has to outlast the inner ones; it must stay a bound (finite, sane).
    const { WINDOWS_PANE_PROBE_TIMEOUT_MS, PANE_PROBE_TIMEOUT_MS } = await import('./pane-probe')
    expect(WINDOWS_PANE_PROBE_TIMEOUT_MS).toBeGreaterThan(PANE_PROBE_TIMEOUT_MS)
    expect(WINDOWS_PANE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
  })
})
