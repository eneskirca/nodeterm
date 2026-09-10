import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { confirmKeyAction } from './confirm-key'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'

interface ConfirmDialogProps {
  message: string
  /** Optional content rendered ABOVE the message (e.g. the remote-access ConsentNotice), so the
   *  human reads what they are granting before the SAS body + buttons. `bodyPosition` moves it. */
  body?: ReactNode
  /** Where `body` sits relative to `message`. 'above' (default) suits a consent notice the
   *  reader must see BEFORE the ask; 'below' suits a list the message refers to ("the sessions
   *  below") — the reason must lead and the rows follow it. */
  bodyPosition?: 'above' | 'below'
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Nothing to decide — the dialog only REPORTS (an error, a "not ready yet"). Renders a single
   *  dismiss button instead of the destructive default pair: an error message offering
   *  "Cancel / Delete" reads as though dismissing it will delete something. */
  alert?: boolean
  /** An explicit opt-in shown above the buttons (e.g. "Delete the worktree directory from disk
   *  too"). The caller owns the value, so it can also swap the confirm label / danger styling. */
  option?: { label: string; checked: boolean; onChange: (checked: boolean) => void }
  /**
   * May Enter confirm this dialog? Default true — the user asked for it. Pass FALSE for a dialog
   * the app raised on someone ELSE's behalf (an agent verb like `close-worktree`): the user never
   * asked for it, it appeared under their hands, and it must be answered by an explicit click.
   * Escape still cancels either way.
   */
  enterConfirms?: boolean
  /**
   * When false, NEITHER button takes `autoFocus`. Default true (historical behavior). Pass false
   * for a dialog that appears under the user's hands (the capability clone notice): `autoFocus`
   * steals focus from whatever they were typing in, and their next Enter/Space then NATIVELY
   * activates the focused button — a path `enterConfirms`/confirm-key never sees, because the
   * browser's default button activation is not the window keydown listener (PR #213 review, I1).
   */
  autoFocusButtons?: boolean
  onConfirm: () => void
  onCancel: () => void
  /**
   * When provided, Escape and an overlay click call THIS instead of `onCancel`, and the cancel
   * button remains the only path to `onCancel`. For a dialog where cancel is itself a recorded
   * ANSWER (the capability clone notice's "Turn it off"), a stray Escape aimed at a terminal or a
   * misclick outside the box must be a non-answer — close for now, decide nothing — not a
   * consent-recording cancel (PR #213 review, I1). Absent = historical behavior (dismissal
   * cancels).
   */
  onDismiss?: () => void
}

/**
 * A small themed confirm dialog. Enter confirms and Esc cancels — but only under the conditions in
 * ./confirm-key, which exist because this listener is on `window` and therefore sees every key the
 * user aims at a terminal, a chat box or the command palette. Read that file before touching the
 * key handling: a stray Enter used to be able to delete a worktree.
 */
export function ConfirmDialog({
  message,
  body,
  bodyPosition = 'above',
  confirmLabel,
  cancelLabel = 'Cancel',
  danger: dangerProp,
  alert = false,
  option,
  enterConfirms = true,
  autoFocusButtons = true,
  onConfirm,
  onCancel,
  onDismiss
}: ConfirmDialogProps) {
  // Escape / overlay-click land here: the caller's dismiss channel when it has one, else cancel.
  const dismiss = onDismiss ?? onCancel
  // An alert has nothing destructive to warn about and nothing to cancel; anything else keeps the
  // historical destructive defaults ("Delete", danger styling, focus parked on the safe button).
  const danger = dangerProp ?? !alert
  const confirmText = confirmLabel ?? (alert ? 'OK' : 'Delete')
  // One id per instance, for the lifetime of the component (mount order == paint order == stack).
  const idRef = useRef<string>()
  if (!idRef.current) idRef.current = nextDialogId()
  const id = idRef.current
  const boxRef = useRef<HTMLDivElement>(null)
  // Set once, on the first render — not in an effect, so a key that arrives before the effect runs
  // is still measured against the moment the dialog appeared.
  const mountedAtRef = useRef(Date.now())

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = confirmKeyAction({
        key: e.key,
        repeat: e.repeat,
        // Not the dialog on top → this key is not ours (the topmost dialog's own listener still has
        // to see it, so we must not preventDefault it either).
        top: isTopDialog(id),
        // Aimed HERE, not at whatever had focus when we appeared. `boxRef` is the dialog box, so a
        // key typed into a terminal underneath the overlay can never answer it.
        inDialog: !!(e.target instanceof Node && boxRef.current?.contains(e.target)),
        sinceMount: Date.now() - mountedAtRef.current,
        enterConfirms
      })
      if (!action) return
      e.preventDefault()
      if (action === 'confirm') onConfirm()
      else dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, enterConfirms, onConfirm, dismiss])

  return createPortal(
    <div className="confirm-overlay" onClick={dismiss}>
      <div className="confirm" ref={boxRef} onClick={(e) => e.stopPropagation()}>
        {body && bodyPosition === 'above' && body}
        <p className="confirm__msg">{message}</p>
        {body && bodyPosition === 'below' && body}
        {option && (
          <label className="confirm__option">
            <input
              type="checkbox"
              checked={option.checked}
              onChange={(e) => option.onChange(e.target.checked)}
            />
            {option.label}
          </label>
        )}
        <div className="confirm__actions">
          {/* The DESTRUCTIVE button never takes focus: autoFocus on it is what turned a stray Enter
              (or Space) into a deletion. On a danger dialog the safe button is the focused one; on a
              harmless one the primary action may keep it. */}
          {!alert && (
            <button className="confirm__btn" autoFocus={autoFocusButtons && danger} onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button
            className={`confirm__btn${danger ? ' danger' : ' primary'}`}
            autoFocus={autoFocusButtons && !danger}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
