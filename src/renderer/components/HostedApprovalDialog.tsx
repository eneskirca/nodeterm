// A device's first join of a hosted team: an OWNER compares the SAS with the person joining (out of
// band — a call, a chat) and picks the role it gets. Default Viewer, the least privilege.
//
// A REMOTE device raised this under the owner's hands, so it follows the Team Access dialog's rules
// and adds two of its own (components/confirm-key):
//  - Enter NEVER approves — not from the window, not aimed at the dialog, not the browser's own
//    activation of a focused button. Only a click on Allow grants anything.
//  - Escape declines, like every dialog here, but only once the dialog is armed and never on a
//    held key: requests queue (up to 16), and one key held down must not deny a line of teammates.
//  - The focus lands on Deny, the safe answer, never on Allow.
// Built on ConfirmDialog's classes and the dialog stack, so z-order and Escape ownership match every
// other dialog. See docs/hosted-team-relay.md.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HostedPending, HostedRole } from '@shared/types'
import { keyFingerprint } from '../lib/hostedTeam'
import { CONFIRM_ARM_MS } from './confirm-key'
import { useDialogStack } from './dialog-stack'

// What each role can reach, stated at its fullest: an owner decides from this line alone. A Viewer
// reads every file in the shared folder (the access policy jails reads to the folder, not to what
// is safe in it) and sees git only for a folder that is its own repository (access-policy.ts).
const ROLE_COPY: Record<HostedRole, string> = {
  viewer:
    "Can read every file in the shared project's folder, .env files included, and watch its terminals and anything printed in them. Its git history too, when the folder is a repository of its own.",
  commenter: 'Viewer access, and can comment on cards and in cursor chat.',
  editor: 'Can type into terminals, edit files and run git — the same as SSH access',
  owner: 'Editor access, plus approving, removing and changing roles'
}

export function HostedApprovalDialog(props: {
  pending: HostedPending
  teamLabel: string
  /** Requests waiting behind this one. */
  more?: number
  onApprove(pendingId: string, role: HostedRole): void
  onDeny(pendingId: string): void
}): React.JSX.Element {
  const { pending, teamLabel, more = 0, onApprove, onDeny } = props
  const [role, setRole] = useState<HostedRole>('viewer')
  const isTop = useDialogStack()
  // Set on the first render, not in an effect: a key already on its way when the dialog appeared is
  // measured against the moment it appeared.
  const mountedAtRef = useRef(Date.now())
  const denyRef = useRef(onDeny)
  denyRef.current = onDeny

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.preventDefault()
      if (e.repeat || Date.now() - mountedAtRef.current < CONFIRM_ARM_MS) return
      denyRef.current(pending.pendingId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, pending.pendingId])

  const team = teamLabel.trim() || 'this team'
  const grant =
    role === 'editor' || role === 'owner' ? `${ROLE_COPY[role]} — they can run commands on ${team}.` : ROLE_COPY[role]

  return createPortal(
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="A device wants to join the team">
      <div
        className="confirm"
        // Enter answers nothing here. Blocking it in the capture phase also stops the browser from
        // turning Enter on a focused button into a click.
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter') e.preventDefault()
        }}
      >
        <div className="confirm__msg">
          <strong>A device wants to join {team}</strong>
          {'\n\n'}Compare this code with the person joining (call or chat) before allowing:{'\n\n'}
          <strong>{pending.sas}</strong>
          {'\n\n'}Device key {keyFingerprint(pending.peerKeyB64)}
          {more > 0 ? `\n\n${more} more ${more === 1 ? 'request is' : 'requests are'} waiting.` : ''}
          {'\n\n'}Role:
        </div>
        {/* The app's dialog field (the prompt dialogs' input), so the picker reads as part of it. */}
        <select
          className="confirm__input"
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as HostedRole)}
        >
          <option value="viewer">Viewer</option>
          <option value="commenter">Commenter</option>
          <option value="editor">Editor</option>
          <option value="owner">Owner</option>
        </select>
        <p className="remote-consent" role="note">
          {grant}
        </p>
        <div className="confirm__actions">
          <button className="confirm__btn" autoFocus onClick={() => onDeny(pending.pendingId)}>
            Deny
          </button>
          <button className="confirm__btn danger" onClick={() => onApprove(pending.pendingId, role)}>
            Allow
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
