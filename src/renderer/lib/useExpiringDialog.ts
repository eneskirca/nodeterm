import { useEffect } from 'react'

import { expiredDialogNotice } from '@shared/control-confirm'

/**
 * The little an expiring dialog's state must carry. Structural, not a named union: the two dialogs
 * that use this (`ConfirmState`, `RemoveState`) have nothing else in common and should not be made
 * to share a type for the sake of one hook.
 */
export interface ExpiringDialog {
  /** `Date.now()`-scale deadline. ABSENT = never expires, which is every human-opened dialog. */
  expiresAt?: number
  /** Named in the notice. Absent ⇒ "an agent", since only an agent-raised dialog gets a deadline. */
  requestedBy?: string
  /** The dialog's chance to answer whoever is still waiting on it. Optional: a dialog whose caller
   *  was already replied to has nobody to tell (see `close-worktree --mode remove`). */
  onExpire?: () => void
}

/**
 * Collect an agent-raised dialog that nobody answered.
 *
 * WHY THIS EXISTS AT ALL, and it is not really about tidiness: these dialogs are serialized by
 * `confirmBusy()`, so one that stays open does not merely sit there — it REFUSES every later
 * destructive verb with "a confirmation is already pending — try again" for the rest of the app
 * run. The agent is told that refusal is retryable, so it retries into the same wall, and the
 * moment the human finally answers the stale dialog a queued retry raises a fresh one. That loop
 * was the "the same dialog keeps coming back" report (PR #740).
 *
 * EXTRACTED rather than copied. The rule was written once for the canvas-control confirm and the
 * worktree-removal dialog needed the identical behaviour; a second effect beside the first is how
 * the two would drift — one gaining a fix the other silently lacks, which is the defect shape this
 * repo keeps paying for. Both callers pass their own `clear`, because releasing a dialog is not
 * uniform: the removal dialog also has to release `removePendingRef`, the guard that covers the
 * async gap before its state exists, and an expiry that dropped the state while leaving that ref
 * latched would reproduce the very bug it is closing.
 *
 * `dialog` is expected to be REPLACED wholesale per dialog (both callers hold it in `useState`),
 * so its identity is the effect's key: a re-render with the same object neither re-arms nor
 * cancels the timer.
 */
export function useExpiringDialog(
  dialog: ExpiringDialog | null | undefined,
  clear: () => void,
  notify: (text: string) => void
): void {
  useEffect(() => {
    const at = dialog?.expiresAt
    if (!at) return
    const fire = (): void => {
      dialog?.onExpire?.()
      clear()
      // Non-blocking on purpose: an alert would itself be a confirm state, i.e. it would keep
      // `confirmBusy` true and reproduce the bug with better wording.
      notify(expiredDialogNotice(dialog?.requestedBy))
    }
    // Already past — a deadline can be in the past when the state is restored or the tab was
    // suspended across it. Fire now rather than arming a negative timeout.
    const ms = at - Date.now()
    if (ms <= 0) {
      fire()
      return
    }
    const t = setTimeout(fire, ms)
    return () => clearTimeout(t)
    // `dialog` identity is the key; `clear`/`notify` are stable setters from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog])
}
