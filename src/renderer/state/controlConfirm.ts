import { create } from 'zustand'

import { isWaivableVerb } from '@shared/control-confirm'

/**
 * Canvas-control confirm waivers granted for THIS APP RUN — the "Don't ask again" checkbox in the
 * destructive-verb dialog.
 *
 * **In memory, and that is the feature, not a shortcut.** It is neither persisted here nor mirrored
 * into `settings.json` (`localStorage` included — a browser-origin store would outlive the process
 * exactly the way this must not). Restarting nodeterm restores the dialog, so the widest thing a
 * user can grant from inside a dialog that appeared under their hands is bounded by the app's own
 * lifetime. The PERMANENT waiver exists too, and it lives in Settings → Agents where it is
 * labelled as permanent and cannot be granted by a stray click on a confirm.
 *
 * It is a store rather than a module-level `Set` for one reason: Settings renders the live list, so
 * granting a waiver must re-render the row that revokes it.
 */
interface ControlConfirmState {
  /** Verbs waived for this app run, insertion-ordered. */
  sessionWaived: string[]
  /** The set the pure decision takes. Rebuilt per change, so identity is a usable change signal. */
  sessionWaivedSet: ReadonlySet<string>
  waiveForSession(verb: string): void
  revokeForSession(verb: string): void
}

export const useControlConfirm = create<ControlConfirmState>((set) => ({
  sessionWaived: [],
  sessionWaivedSet: new Set<string>(),
  waiveForSession: (verb) =>
    set((s) => {
      // The table decides, here as well as in `decideControlConfirm` — a caller cannot grant a
      // waiver for a verb that may not be waived, even by passing the wrong string.
      if (!isWaivableVerb(verb) || s.sessionWaived.includes(verb)) return s
      const next = [...s.sessionWaived, verb]
      return { sessionWaived: next, sessionWaivedSet: new Set(next) }
    }),
  revokeForSession: (verb) =>
    set((s) => {
      if (!s.sessionWaived.includes(verb)) return s
      const next = s.sessionWaived.filter((v) => v !== verb)
      return { sessionWaived: next, sessionWaivedSet: new Set(next) }
    })
}))

/** The set for a non-reactive reader (the control dispatch runs inside an IPC listener). */
export function sessionWaivedVerbs(): ReadonlySet<string> {
  return useControlConfirm.getState().sessionWaivedSet
}
