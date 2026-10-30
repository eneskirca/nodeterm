import { create } from 'zustand'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState } from '@shared/project-limit'

/**
 * The renderer's copy of the free-tier open-project limit state (core/project-limit.ts computes it;
 * docs/project-limit.md). Core is the authority: this
 * store only mirrors it — the boot read (`hydrate`) and every `projectLimit:changed` push replace
 * `state` wholesale. It starts, and stays on any failed read, at `INACTIVE_PROJECT_LIMIT`: the
 * dormant answer, under which every open behaves exactly as before the limit existed.
 *
 * Desktop: the preload's `projectLimit`. Server Edition: the bridge stub answers inactive forever.
 * A relay tab keeps the LOCAL preload's api (the allowance is this machine's, never the host's).
 */
/**
 * What the limit dialog (components/ProjectLimitDialog.tsx) is asked to show — spec §7:
 * - `limit`: still at the limit after any claim; Close / Cancel / Pro.
 * - `consent`: DO_NOT_TRACK without consent; a claim needs the user's yes first (§7.4).
 * - `error`: the claim could not get an answer (offline, server error); adds Retry.
 * - `mismatch`: the allowance is tied to another computer; `retryAfter` (unix seconds) says when
 *   it may move to this one.
 */
export type LimitDialogRequest = { mode: 'limit' | 'consent' | 'error' | 'mismatch'; retryAfter?: number }

/**
 * How the dialog was left. `proceed` = the open may go ahead NOW (a Close made room, Pro arrived) —
 * the gate re-decides rather than trusting it; `retry` = claim again; `consent` = the user allowed
 * the license connection; `cancel` = the open does not happen.
 */
export type DialogOutcome = 'proceed' | 'cancel' | 'retry' | 'consent'

interface ProjectLimitStore {
  state: ProjectLimitState
  /** The dialog the open gate (lib/projectLimitGate.ts) is waiting on, or `null`. At most one.
   *  Close it ONLY through `resolveDialog`: the gate holds a promise for it and refuses every other
   *  open while that is pending, so clearing this field any other way (`setState({ dialog: null })`)
   *  leaves the promise unsettled and latches every later at-limit open to `false`. */
  dialog: LimitDialogRequest | null
  /** §7's "brief spinner": a person's claim is still in flight after `CHECKING_DELAY_MS`. */
  checking: boolean
  /** Read core's current state. Never rejects: a failed read keeps whatever is held (inactive until
   *  core has said otherwise). Called from the boot effect AFTER the projects store is hydrated —
   *  core records the first-launch open count on the first read it answers with the index loaded. */
  hydrate(): Promise<void>
  /** Settle the open dialog with `outcome` and take it down. Nothing shown → nothing happens. */
  resolveDialog(outcome: DialogOutcome): void
}

/** The settle function of the dialog currently shown. Module state rather than store state: a
 *  function is not something a component should render from. */
let settleDialog: ((outcome: DialogOutcome) => void) | null = null

export const useProjectLimit = create<ProjectLimitStore>((set) => {
  // Live updates from core: a server word, a license or settings change, time passing the deadline.
  // Subscribed at creation (the entitlement store's shape), so a push that lands before the first
  // read is not lost.
  window.nodeTerminal.projectLimit.onChange((state) => set({ state }))
  return {
    state: INACTIVE_PROJECT_LIMIT,
    dialog: null,
    checking: false,
    resolveDialog(outcome) {
      const settle = settleDialog
      if (!settle) return
      settleDialog = null
      set({ dialog: null })
      settle(outcome)
    },
    async hydrate() {
      try {
        set({ state: await window.nodeTerminal.projectLimit.state() })
      } catch (err) {
        console.warn('[project-limit] state read failed', err instanceof Error ? err.message : String(err))
      }
    }
  }
})

/**
 * Show the limit dialog and wait for how it is left. The open gate's `showDialog`; only the gate
 * calls it, and it never has two up at once. Should a second request arrive anyway, the one it
 * replaces is settled `cancel` first, so no caller is ever left waiting on a dialog nobody can see.
 */
export function showProjectLimitDialog(request: LimitDialogRequest): Promise<DialogOutcome> {
  if (settleDialog) useProjectLimit.getState().resolveDialog('cancel')
  return new Promise<DialogOutcome>((resolve) => {
    settleDialog = resolve
    useProjectLimit.setState({ dialog: { ...request } })
  })
}

/** Raise or lower the "Checking your free allowance…" panel. The open gate's `setChecking`. */
export function setProjectLimitChecking(on: boolean): void {
  if (useProjectLimit.getState().checking !== on) useProjectLimit.setState({ checking: on })
}
