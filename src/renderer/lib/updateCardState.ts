// The update card's state machine — pure, so every transition unit-tests without React or Electron.
//
// Rules the card used to break, each one a user-visible annoyance:
//  - A staged update must never be downgraded: a 6h re-check's repeat `available` turned "Update
//    ready" back into "Downloading 0%" and un-minimized it. `downloaded` (and the install phases
//    after it) and the mandatory `required` card are only ever replaced by something further along.
//  - A repeat of what the card already shows must not un-minimize it, and a version the user
//    dismissed stays dismissed until they ask (a user check) or a newer version arrives.
//  - Automatic checks download QUIETLY: the card appears at `downloaded`, not as a progress bar the
//    user never asked for. A user-initiated check shows its progress; closing that progress card
//    drops back to quiet mode, it does not stop tracking the download.
//  - Errors never overwrite `downloaded` or `required` (main already keeps background failures off
//    the card; this is the second line).
import { isNewerVersion } from '@shared/update-gate'
import type { UpdatePolicy } from '@shared/types'

export type CardStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; percent: number; notes?: string }
  // A .deb/.rpm Linux install (or the check-only Windows beta) can't self-install — a manual
  // download link, no progress/restart.
  | { kind: 'manual'; version: string; notes?: string }
  // This build has no update channel at all (issue #814): "we cannot look", not "you are current".
  | { kind: 'noChannel' }
  // `installError`: a restart that was attempted and failed — the update is still staged.
  | { kind: 'downloaded'; version: string; notes?: string; installError?: string }
  | { kind: 'preparing'; version: string }
  | { kind: 'restarting'; version: string }
  | { kind: 'upToDate' }
  | { kind: 'required'; minSupported: string | null; percent: number | null }
  | { kind: 'error'; message: string }
  // First launch of a new version: a one-time "Updated to vX" note.
  | { kind: 'updated'; version: string }

export interface CardState {
  status: CardStatus
  minimized: boolean
  /** Self-install download running without a card (automatic check, or progress card closed). */
  quiet: boolean
  /** The current flow was started by the user (Settings → Check, "Update now"). */
  userInitiated: boolean
  /** The version whose card the user closed; not resurrected by a background repeat. */
  dismissedVersion: string | null
  /** Main acknowledged the restart click (sent `installing`). */
  installAck: boolean
}

export type CardEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; notes?: string; manual?: boolean }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string; notes?: string }
  | { type: 'notAvailable' }
  | { type: 'upToDateExpired' }
  | { type: 'noChannel' }
  | { type: 'error'; message: string }
  | { type: 'installing'; phase: 'preparing' | 'restarting'; version: string | null }
  | { type: 'restartClicked' }
  | { type: 'restartStalled' }
  | { type: 'policy'; policy: UpdatePolicy }
  | { type: 'dismiss' }
  | { type: 'minimize' }
  | { type: 'restore' }
  | { type: 'updated'; version: string }
  | { type: 'updatedExpired' }
  | { type: 'simulate'; status: CardStatus }

export const INITIAL_CARD_STATE: CardState = {
  status: { kind: 'idle' },
  minimized: false,
  quiet: false,
  userInitiated: false,
  dismissedVersion: null,
  installAck: false
}

/** The version a status is about, if any. */
export function statusVersion(s: CardStatus): string | null {
  return 'version' in s ? s.version : null
}

/** Staged or further along: only a newer staged version may replace these. */
function isStaged(s: CardStatus): s is Extract<CardStatus, { kind: 'downloaded' | 'preparing' | 'restarting' }> {
  return s.kind === 'downloaded' || s.kind === 'preparing' || s.kind === 'restarting'
}

/** Whether the card renders at all. */
export function cardVisible(state: CardState): boolean {
  if (state.status.kind === 'idle') return false
  return !(state.quiet && state.status.kind === 'available')
}

export function nextCardState(state: CardState, ev: CardEvent): CardState {
  const s = state.status
  switch (ev.type) {
    case 'checking': {
      const keep =
        s.kind === 'available' || s.kind === 'manual' || s.kind === 'required' || isStaged(s)
      return {
        ...state,
        status: keep ? s : { kind: 'checking' },
        minimized: false,
        quiet: false,
        userInitiated: true,
        dismissedVersion: null
      }
    }

    case 'available': {
      if (isStaged(s) && !isNewerVersion(ev.version, s.version)) return state
      // A newer release behind a staged one downloads in the background; the ready card stays
      // until that one is ready too.
      if (isStaged(s)) return state
      if (s.kind === 'required') {
        // The remedy is on its way: a check-only build hands over to its download card (the one
        // action it has), a self-installing one keeps the mandatory card and shows progress in it.
        if (ev.manual) return { ...state, status: { kind: 'manual', version: ev.version, notes: ev.notes }, minimized: false }
        return { ...state, status: { ...s, percent: 0 } }
      }
      if (!state.userInitiated && state.dismissedVersion === ev.version) return state
      if (ev.manual) {
        const repeat = s.kind === 'manual' && s.version === ev.version
        return {
          ...state,
          status: { kind: 'manual', version: ev.version, notes: ev.notes || (repeat ? s.notes : undefined) },
          minimized: repeat ? state.minimized : false,
          quiet: false
        }
      }
      if (s.kind === 'available' && s.version === ev.version) {
        return state.userInitiated ? { ...state, quiet: false, minimized: false } : state
      }
      return {
        ...state,
        status: { kind: 'available', version: ev.version, percent: 0, notes: ev.notes },
        quiet: !state.userInitiated,
        minimized: false
      }
    }

    case 'progress':
      if (s.kind === 'available') return { ...state, status: { ...s, percent: ev.percent } }
      if (s.kind === 'required' && s.percent !== null) return { ...state, status: { ...s, percent: ev.percent } }
      return state

    case 'downloaded': {
      if (isStaged(s)) {
        if (!isNewerVersion(ev.version, s.version)) {
          // A repeat (or the manual-check echo): no un-minimize unless the user asked.
          return state.userInitiated ? { ...state, minimized: false, userInitiated: false } : state
        }
      } else if (!state.userInitiated && state.dismissedVersion === ev.version) {
        return state
      }
      const notes = ev.notes || ((s.kind === 'available' || s.kind === 'manual') && s.version === ev.version ? s.notes : undefined)
      return {
        ...state,
        status: { kind: 'downloaded', version: ev.version, notes: notes || undefined },
        minimized: false,
        quiet: false,
        userInitiated: false,
        installAck: false
      }
    }

    case 'notAvailable': {
      // Automatic checks are silent: "You're up to date" answers a question only the user asks.
      if (!state.userInitiated) return state
      const keep = s.kind === 'required' || s.kind === 'available' || s.kind === 'manual' || isStaged(s)
      return { ...state, status: keep ? s : { kind: 'upToDate' }, minimized: false, userInitiated: false }
    }

    case 'upToDateExpired':
      return s.kind === 'upToDate' ? { ...state, status: { kind: 'idle' } } : state

    case 'noChannel':
      // Never auto-hides, unlike `upToDate`: this card carries the only action the user has.
      return s.kind === 'required'
        ? { ...state, userInitiated: false }
        : { ...state, status: { kind: 'noChannel' }, minimized: false, userInitiated: false }

    case 'error': {
      if (s.kind === 'preparing' || s.kind === 'restarting')
        return {
          ...state,
          status: { kind: 'downloaded', version: s.version, installError: ev.message },
          minimized: false,
          userInitiated: false,
          installAck: false
        }
      if (s.kind === 'downloaded' || s.kind === 'required') return { ...state, userInitiated: false }
      return {
        ...state,
        status: { kind: 'error', message: ev.message },
        minimized: false,
        quiet: false,
        userInitiated: false
      }
    }

    case 'installing': {
      const version = ev.version ?? statusVersion(s) ?? ''
      return { ...state, status: { kind: ev.phase, version }, minimized: false, quiet: false, installAck: true }
    }

    case 'restartClicked':
      return s.kind === 'downloaded'
        ? { ...state, status: { kind: 'preparing', version: s.version }, installAck: false }
        : state

    case 'restartStalled':
      // The click was never acknowledged (main refused it): give the button back.
      return s.kind === 'preparing' && !state.installAck
        ? { ...state, status: { kind: 'downloaded', version: s.version } }
        : state

    case 'policy': {
      const p = ev.policy
      if (p.mandatory) {
        if (isStaged(s) || s.kind === 'manual') return state
        if (s.kind === 'required') return { ...state, status: { ...s, minSupported: p.minSupported } }
        return {
          ...state,
          status: { kind: 'required', minSupported: p.minSupported, percent: s.kind === 'available' ? s.percent : null },
          minimized: false,
          quiet: false
        }
      }
      // A real answer (a minimum is known) that no longer requires the update clears the card —
      // a rolled-back minSupported. An empty/failed read (no minimum) is no evidence of anything.
      if (s.kind === 'required' && p.minSupported !== null) return { ...state, status: { kind: 'idle' } }
      return state
    }

    case 'dismiss': {
      if (s.kind === 'required') return state
      // Closing a progress card drops back to quiet tracking; the ready card still comes.
      if (s.kind === 'available') return { ...state, quiet: true, minimized: false, userInitiated: false }
      return {
        ...state,
        status: { kind: 'idle' },
        minimized: false,
        userInitiated: false,
        dismissedVersion: statusVersion(s) ?? state.dismissedVersion
      }
    }

    case 'minimize':
      return { ...state, minimized: true }

    case 'restore':
      return { ...state, minimized: false }

    case 'updated':
      return s.kind === 'idle' ? { ...state, status: { kind: 'updated', version: ev.version } } : state

    case 'updatedExpired':
      return s.kind === 'updated' ? { ...state, status: { kind: 'idle' } } : state

    case 'simulate':
      return { ...state, status: ev.status, quiet: false, minimized: false }
  }
}
