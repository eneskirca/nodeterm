import {
  countOpenProjects,
  decideOpen,
  effectiveLimit,
  type ClaimResult,
  type ProjectLimitState
} from '@shared/project-limit'
import {
  setProjectLimitChecking,
  showProjectLimitDialog,
  useProjectLimit,
  type DialogOutcome,
  type LimitDialogRequest
} from '../state/projectLimit'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'

/**
 * The one renderer gate in front of every way a project becomes open (spec §7,
 * docs/superpowers/specs/2026-10-29-free-tier-project-limit-design.md). It ANSWERS whether one new
 * open may proceed; it never closes, deletes or detaches anything (§2).
 *
 * Two invariants the callers (Canvas's open paths, Task 18; the agent verb, Task 19) depend on:
 * - **Allowed is synchronous.** `gateProjectOpen()` returns the literal `true` in the same tick when
 *   `decideOpen` allows — no promise, no microtask — so a caller that mutates the store right after
 *   it keeps today's synchronous path, and two opens at the edge cannot both read the same count.
 *   While the limit is off this is the ONLY branch reached: no claim, no spinner, no dialog.
 * - **One loop at a time.** A request that arrives while a person's open is being decided (claiming,
 *   or a dialog up — a person's or an agent's) is refused, not queued: queued, it would re-decide on
 *   a count the first open has not added to yet and both would open past the limit.
 */

/** §7's "brief spinner": raised only for a claim still in flight after this long. */
export const CHECKING_DELAY_MS = 300

/** An agent's refusal shows the user the limit dialog at most once in this window (§7.5: once per
 *  refusal burst, not per retry). Measured from when the dialog was last shown for an agent. */
export const AGENT_DIALOG_QUIET_MS = 60_000

export interface ProjectOpenGateDeps {
  getState(): ProjectLimitState
  openCount(): number
  /** Core's claim. Never rejects by contract; a rejection is treated as `offline` anyway. */
  claim(): Promise<ClaimResult>
  /** Store the DO_NOT_TRACK consent where core reads it, resolving only once core can see it. */
  setConsent(): Promise<void>
  showDialog(r: LimitDialogRequest): Promise<DialogOutcome>
  setChecking(on: boolean): void
  now(): number
}

export type AgentOpenCheck = { ok: true } | { ok: false; message: string }

export interface ProjectOpenGate {
  gateProjectOpen(): true | Promise<boolean>
  checkAgentProjectOpen(): Promise<AgentOpenCheck>
}

/** The dialog that explains a failed claim. A repeated `consent_required` right after the user
 *  consented means core still cannot see it: asking again would loop, so it reads as an error. */
function dialogFor(r: Extract<ClaimResult, { ok: false }>, consentGiven: boolean): LimitDialogRequest {
  if (r.error === 'consent_required' && !consentGiven) return { mode: 'consent' }
  if (r.error === 'machine_mismatch') {
    return r.retryAfter === undefined ? { mode: 'mismatch' } : { mode: 'mismatch', retryAfter: r.retryAfter }
  }
  return { mode: 'error' }
}

export function createProjectOpenGate(deps: ProjectOpenGateDeps): ProjectOpenGate {
  /** A person's open is being decided (claiming or showing a dialog). */
  let busy = false
  /** A dialog is up — a person's or one shown for an agent. */
  let dialogOpen = false
  let lastAgentDialogAt = Number.NEGATIVE_INFINITY

  async function claim(): Promise<ClaimResult> {
    try {
      return await deps.claim()
    } catch (err) {
      console.warn('[project-limit] claim rejected', err instanceof Error ? err.message : String(err))
      return { ok: false, error: 'offline', state: deps.getState() }
    }
  }

  /** A person's claim: the spinner goes up only if it is still in flight after CHECKING_DELAY_MS,
   *  and comes down the moment it settles. */
  async function claimShowingCheck(): Promise<ClaimResult> {
    let raised = false
    const timer = setTimeout(() => {
      raised = true
      deps.setChecking(true)
    }, CHECKING_DELAY_MS)
    try {
      return await claim()
    } finally {
      clearTimeout(timer)
      if (raised) deps.setChecking(false)
    }
  }

  async function show(r: LimitDialogRequest): Promise<DialogOutcome> {
    dialogOpen = true
    try {
      return await deps.showDialog(r)
    } finally {
      dialogOpen = false
    }
  }

  async function decideForPerson(): Promise<boolean> {
    busy = true
    try {
      let claimNext = false
      let consentGiven = false
      for (;;) {
        const d = decideOpen(deps.getState(), deps.openCount())
        if (d === 'allow') return true
        let request: LimitDialogRequest = { mode: 'limit' }
        // At most one claim per pass: when there is no allowance yet, or after Retry / consent.
        if (d === 'claim' || claimNext) {
          claimNext = false
          const r = await claimShowingCheck()
          // Decided on the claim's own answer — core's state right after it — with the live count.
          if (decideOpen(r.state, deps.openCount()) === 'allow') return true
          if (!r.ok) request = dialogFor(r, consentGiven)
        }
        const outcome = await show(request)
        if (outcome === 'cancel') return false
        if (outcome === 'retry') claimNext = true
        if (outcome === 'consent') {
          try {
            await deps.setConsent()
          } catch (err) {
            console.warn('[project-limit] storing consent failed', err instanceof Error ? err.message : String(err))
          }
          consentGiven = true
          claimNext = true
        }
        // `proceed`: the dialog saw room; the next pass re-decides rather than trusting it.
      }
    } finally {
      busy = false
    }
  }

  function gateProjectOpen(): true | Promise<boolean> {
    if (decideOpen(deps.getState(), deps.openCount()) === 'allow') return true
    if (busy || dialogOpen) return Promise.resolve(false)
    return decideForPerson()
  }

  /** Show the user the limit dialog for an agent's refusal — not while one is up (or a person's open
   *  is being decided), and not again within the quiet window. The agent does not wait for it. */
  function showForAgent(): void {
    if (busy || dialogOpen) return
    const t = deps.now()
    if (t - lastAgentDialogAt < AGENT_DIALOG_QUIET_MS) return
    lastAgentDialogAt = t
    void show({ mode: 'limit' }).catch(() => {})
  }

  async function checkAgentProjectOpen(): Promise<AgentOpenCheck> {
    let state = deps.getState()
    let d = decideOpen(state, deps.openCount())
    if (d === 'allow') return { ok: true }
    if (d === 'claim') {
      // Never the consent dialog and never the spinner: nobody pressed anything. A claim that needs
      // consent simply leaves the state blocking.
      const r = await claim()
      state = r.state
      d = decideOpen(state, deps.openCount())
      if (d === 'allow') return { ok: true }
    }
    showForAgent()
    return {
      ok: false,
      message: `free plan: ${deps.openCount()} of ${effectiveLimit(state)} projects are open; the user has been shown the options`
    }
  }

  return { gateProjectOpen, checkAgentProjectOpen }
}

/** The gate's deps bound to the live stores and bridge. Exported for its tests. */
export const liveProjectOpenGateDeps: ProjectOpenGateDeps = {
  getState: () => useProjectLimit.getState().state,
  openCount: () => countOpenProjects(useProjects.getState().projects),
  claim: () => window.nodeTerminal.projectLimit.claim(),
  async setConsent() {
    const settings = useSettings.getState()
    settings.update({ licenseNetworkConsent: true })
    // `update` only schedules a coalesced save; core reads the consent from ITS copy of the
    // settings, so the claim that follows must wait until that copy has it.
    await settings.flush()
  },
  showDialog: showProjectLimitDialog,
  setChecking: setProjectLimitChecking,
  now: () => Date.now()
}

const liveGate = createProjectOpenGate(liveProjectOpenGateDeps)

/** Whether a person's open may proceed: the literal `true` synchronously when allowed, else a
 *  promise that the limit dialog (and a claim, if needed) settles. */
export const gateProjectOpen = liveGate.gateProjectOpen

/** Whether an agent's `open-project` may proceed; a refusal carries the message to send back. */
export const checkAgentProjectOpen = liveGate.checkAgentProjectOpen
