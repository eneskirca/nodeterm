import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * A SOURCE test, for the same reason `control-destructive.test.ts` is one: the wiring lives inside
 * an 11k-line component's hooks and there is no render harness for it. The BEHAVIOUR of the expiry
 * is proven in `renderer/lib/useExpiringDialog.test.tsx` with real timers; what cannot be reached
 * from there is whether Canvas actually hands the worktree-removal dialog to that hook — and the
 * failure mode is silence, since a dialog that never expires looks exactly like a dialog nobody
 * happened to leave open.
 *
 * PR #740 gave the canvas-control confirm a deadline and left this dialog — the DANGEROUS one,
 * carrying a pre-ticked delete-from-disk choice — holding `confirmBusy()` forever.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('the worktree-removal dialog collects itself, through the SHARED hook', () => {
  it('both expiring dialogs go through useExpiringDialog — no second copy of the rule', () => {
    expect(src).toMatch(/import \{ useExpiringDialog \} from '\.\.\/lib\/useExpiringDialog'/)
    // Exactly two callers: the canvas-control confirm and the worktree-removal dialog.
    expect(src.match(/useExpiringDialog\(/g)).toHaveLength(2)
    // …and the timer itself is not re-implemented beside them. A bare `setTimeout` that clears a
    // dialog state is the copy this test exists to forbid.
    // Non-greedy across the arrow body, because the copy to forbid looks like
    // `setTimeout(() => setRemoveTarget(null), …)` — a `[^)]*` class stops at the arrow's own
    // parens and matches nothing, which is how this assertion first passed a real second copy.
    expect(src).not.toMatch(/setTimeout\([\s\S]{0,200}?setRemoveTarget/)
    expect(src).not.toMatch(/setTimeout\([\s\S]{0,200}?setConfirm\(null\)/)
  })

  it('the removal dialog releases removePendingRef when it expires', () => {
    // `confirmBusy()` reads that ref directly (it covers the async `git.status` gap before
    // `removeTarget` exists), so an expiry that dropped the state and left the ref latched would
    // keep refusing every later destructive verb — the bug, minus the dialog that explained it.
    const call = src.slice(src.indexOf('useExpiringDialog(\n    removeTarget,'))
    expect(call).not.toBe('')
    const body = call.slice(0, call.indexOf('\n  )'))
    expect(body).toContain('removePendingRef.current = false')
    expect(body).toContain('setRemoveTarget(null)')
  })

  it('only an AGENT-requested removal gets a deadline', () => {
    // A removal the USER opened from the group menu must never vanish under them: they asked for
    // it and they are looking at it. The deadline is conditional on `requestedBy`, which is set
    // only by the canvas-control path.
    expect(src).toContain(
      'expiresAt: opts?.requestedBy ? confirmExpiresAt(Date.now()) : undefined'
    )
  })

  it('the removal dialog has NO onExpire — its caller was already answered', () => {
    // `close-worktree --mode remove` replies "removal confirmation shown to the user — they
    // decide" the instant the dialog opens, so there is nobody left to tell. An `onExpire` here
    // would be a reply to a call that finished minutes ago.
    const call = src.slice(src.indexOf('useExpiringDialog(\n    removeTarget,'))
    const body = call.slice(0, call.indexOf('\n  )'))
    expect(body).not.toContain('onExpire')
  })

  it('the deadline is the shared control-request budget, not a second number', () => {
    expect(src).toMatch(/from '@shared\/control-confirm'/)
    // No freshly invented timeout beside it.
    expect(src).not.toMatch(/const\s+\w*REMOVE\w*TIMEOUT\w*\s*=/i)
  })
})
