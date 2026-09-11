// @vitest-environment jsdom
//
// The hook that stops an unanswered agent-raised dialog from wedging every later destructive verb.
// Tested behaviourally (timers, not source reads) because the failure modes are all about WHEN it
// fires: a dialog that never expires is the bug, and one that expires while the user is reading it
// is worse than the bug.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useExpiringDialog, type ExpiringDialog } from './useExpiringDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let cleared: number
let notices: string[]

function Harness({ dialog }: { dialog: ExpiringDialog | null }): null {
  useExpiringDialog(
    dialog,
    () => {
      cleared += 1
    },
    (text) => notices.push(text)
  )
  return null
}

async function render(dialog: ExpiringDialog | null): Promise<void> {
  await act(async () => {
    root.render(<Harness dialog={dialog} />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'))
  cleared = 0
  notices = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useExpiringDialog', () => {
  it('clears the dialog and raises ONE notice at the deadline', async () => {
    await render({ expiresAt: Date.now() + 1000, requestedBy: 'orchestrator' })
    expect(cleared).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(999)
    })
    // Not a millisecond early: the user may still be reading it.
    expect(cleared).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(cleared).toBe(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('orchestrator')
    expect(notices[0]).toContain('nothing was done')
  })

  it('never expires a dialog with no deadline — that is every human-opened one', async () => {
    await render({ requestedBy: undefined })
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000)
    })
    expect(cleared).toBe(0)
    expect(notices).toEqual([])
  })

  it('does nothing when there is no dialog at all', async () => {
    await render(null)
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000)
    })
    expect(cleared).toBe(0)
  })

  it('fires immediately for a deadline already in the past', async () => {
    // Reachable: a suspended tab whose timers were throttled across the deadline. Arming a
    // negative timeout would be indistinguishable from never expiring.
    await render({ expiresAt: Date.now() - 1 })
    expect(cleared).toBe(1)
    expect(notices).toHaveLength(1)
  })

  it('names "an agent" when the dialog does not say who asked', async () => {
    await render({ expiresAt: Date.now() - 1 })
    expect(notices[0]).toContain('an agent')
  })

  it('re-arms for a NEW dialog and cancels the old timer', async () => {
    const first = { expiresAt: Date.now() + 1000, requestedBy: 'first' }
    await render(first)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    // A second dialog replaces the first (the dispatch refuses this today, but the hook must not
    // depend on that): the first one's timer must not fire against the second one's state.
    await render({ expiresAt: Date.now() + 1000, requestedBy: 'second' })
    await act(async () => {
      vi.advanceTimersByTime(999)
    })
    expect(cleared).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(cleared).toBe(1)
    expect(notices[0]).toContain('second')
  })

  it('keeps an ABSOLUTE deadline, so re-renders cannot postpone it', async () => {
    const dialog = { expiresAt: Date.now() + 1000, requestedBy: 'orchestrator' }
    await render(dialog)
    await act(async () => {
      vi.advanceTimersByTime(900)
    })
    // Re-render with the same dialog 100 ms before the deadline. This is what a duration-based
    // timer would get wrong: re-arming "1000 ms from now" on a canvas that re-renders constantly
    // would push the expiry out indefinitely, which is the wedged-dialog bug wearing a timer.
    // (The effect's `[dialog]` key also avoids the churn, but the absolute deadline is what makes
    // the behaviour correct rather than merely cheap.)
    await render(dialog)
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(cleared).toBe(1)
  })

  it('stops when the dialog is answered before the deadline', async () => {
    await render({ expiresAt: Date.now() + 1000, requestedBy: 'orchestrator' })
    await render(null)
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(cleared).toBe(0)
    expect(notices).toEqual([])
  })

  it('calls onExpire exactly once, for a caller that still owes a reply', async () => {
    // The canvas-control confirm uses this to answer `expired` instead of leaving its caller to
    // wait out main's budget. Order against `clear()` is deliberately NOT asserted: `onExpire` is
    // captured from the closure, so it fires either way, and pinning an order nothing depends on
    // is a test that can only ever obstruct a refactor.
    let replies = 0
    await act(async () => {
      root.render(
        <Harness dialog={{ expiresAt: Date.now() + 10, onExpire: () => (replies += 1) }} />
      )
    })
    await act(async () => {
      vi.advanceTimersByTime(10)
    })
    expect(replies).toBe(1)
    expect(cleared).toBe(1)
    // …and it does not keep firing afterwards.
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(replies).toBe(1)
  })

  it('tolerates a dialog with no onExpire — nobody is waiting on that one', async () => {
    // `close-worktree --mode remove` answers its caller the moment the dialog opens.
    await render({ expiresAt: Date.now() + 10, requestedBy: 'orchestrator' })
    await act(async () => {
      vi.advanceTimersByTime(10)
    })
    expect(cleared).toBe(1)
    expect(notices).toHaveLength(1)
  })
})
