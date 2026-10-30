import {
  countOpenProjects,
  decideOpen,
  effectiveLimit,
  type ClaimResult,
  type OpenDecision,
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
 * The one renderer gate in front of every way a project becomes open (docs/project-limit.md, "The
 * limit moment"). It ANSWERS whether one new open may proceed; it never closes, deletes or detaches
 * anything.
 *
 * Two invariants the callers (Canvas's open paths, Task 18; the agent verb, Task 19) depend on:
 * - **Allowed is synchronous.** `gateProjectOpen()` returns the literal `true` in the same tick when
 *   `decideOpen` allows — no promise, no microtask — so a caller that mutates the store right after
 *   it keeps today's synchronous path, and two opens at the edge cannot both read the same count.
 *   While the limit is off this is the ONLY branch reached: no claim, no spinner, no dialog.
 * - **One loop at a time.** A request that arrives while a person's open is being decided (claiming,
 *   or a dialog up — a person's or an agent's) is refused, not queued: queued, it would re-decide on
 *   a count the first open has not added to yet and both would open past the limit.
 *
 * And one rule the server's undo depends on: **a DO_NOT_TRACK install re-claims at a known
 * allowance.** Its check feed never runs, so the claim is the only server word it can hear — and a
 * consenting one that claimed is latched with a token, where `decideOpen` answers `'block'`, not
 * `'claim'`. Without one more claim there it would never hear `not_active` (the limit cleared), an
 * epoch bump or a raised FREE, and the latch outranks the deadline, so not even an unfrozen release
 * would reach it. `reclaimsAtBlock` is that rule: once per gate pass, only under DO_NOT_TRACK (any
 * other install hears all of it on the check feed, and stays byte-identical), and only at the limit
 * (under it the open stays synchronous and claims nothing).
 */

/** The limit moment's "brief spinner" (the "Checking…" panel): raised only for a claim still in
 *  flight after this long. */
export const CHECKING_DELAY_MS = 300

/** An agent's refusal shows the user the limit dialog at most once in this window (once per
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

/** An agent registration run under the limit: what `register` returned, or the refusal. */
export type AgentOpenFinish<T> = { ok: true; value: T } | { ok: false; message: string }

export interface ProjectOpenGate {
  gateProjectOpen(): true | Promise<boolean>
  checkAgentProjectOpen(): Promise<AgentOpenCheck>
  finishAgentProjectOpen<T>(opens: () => boolean, register: () => T): AgentOpenFinish<T> | Promise<AgentOpenFinish<T>>
}

/** A DO_NOT_TRACK install at a known allowance claims once more before it is refused (see above). */
function reclaimsAtBlock(state: ProjectLimitState, d: OpenDecision): boolean {
  return d === 'block' && state.dnt
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
      /** A claim has been made during this gate pass, so the DNT re-claim is spent. */
      let claimed = false
      for (;;) {
        const state = deps.getState()
        const d = decideOpen(state, deps.openCount())
        if (d === 'allow') return true
        let request: LimitDialogRequest = { mode: 'limit' }
        // At most one claim per pass: when there is no allowance yet, after Retry / consent, or —
        // once per gate pass — a DO_NOT_TRACK install at its known allowance.
        const reclaim = !claimed && reclaimsAtBlock(state, d)
        if (d === 'claim' || claimNext || reclaim) {
          claimNext = false
          claimed = true
          const r = await claimShowingCheck()
          // Decided on the claim's own answer — core's state right after it — with the live count.
          if (decideOpen(r.state, deps.openCount()) === 'allow') return true
          // A DNT re-claim (never one the user asked for: Retry and consent follow an earlier claim,
          // which spent it) that failed at an allowance already known and verified offline is no
          // news: today's limit dialog, not "Couldn't check". Missing consent is still asked for,
          // exactly as on a first claim.
          if (!r.ok && (!reclaim || r.error === 'consent_required')) request = dialogFor(r, consentGiven)
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

  /** Every agent refusal, from either check: the user is shown the dialog (under showForAgent's
   *  rules) and the agent gets the one sentence, so the two checks cannot word it twice. The sentence
   *  is also the agent's only documentation of the limit — the canvas-control verb help says nothing
   *  about it, so nothing reaches an agent while the limit is off — hence the "do not retry". */
  function refuseAgent(state: ProjectLimitState): Extract<AgentOpenCheck, { ok: false }> {
    showForAgent()
    return {
      ok: false,
      message: `free plan: ${deps.openCount()} of ${effectiveLimit(state)} projects are open; the user has been shown the options — do not retry`
    }
  }

  async function checkAgentProjectOpen(): Promise<AgentOpenCheck> {
    let state = deps.getState()
    let d = decideOpen(state, deps.openCount())
    if (d === 'allow') return { ok: true }
    if (d === 'claim' || reclaimsAtBlock(state, d)) {
      // Never the consent dialog and never the spinner: nobody pressed anything. A claim that needs
      // consent simply leaves the state blocking.
      const r = await claim()
      state = r.state
      d = decideOpen(state, deps.openCount())
      if (d === 'allow') return { ok: true }
    }
    return refuseAgent(state)
  }

  /**
   * The agent verb's last word, and its store write: the user's confirm dialog sits between
   * `checkAgentProjectOpen` and the registration, and another open may have landed meanwhile. The
   * FINAL decision and `register()` run in one tick — nothing can run between the count read here
   * and the write — so two agents at the edge cannot both pass on one count (plan Review Focus 5).
   *
   * Synchronous whenever the limit decides at once (allow — every call while it is off — or block,
   * except under DO_NOT_TRACK). Only a claim still due returns a promise, and it is due exactly when
   * the early check did NOT claim: it saw room (4 of 5) and an open landed before this point —
   * with no allowance yet, or under DO_NOT_TRACK at a known one (`reclaimsAtBlock`). That claim
   * is made here (never the consent dialog, never the spinner), and the decision is taken on its
   * own answer — the store may not have heard it yet, the rule both other paths follow — with the
   * live count, `register()` following in the same continuation. A legacy install whose allowance
   * is well above FREE is therefore registered, not refused at "5 of 5".
   *
   * `opens` is asked at the decision itself: a registration that no longer opens a project (it was
   * opened meanwhile) is never refused.
   */
  function finishAgentProjectOpen<T>(
    opens: () => boolean,
    register: () => T
  ): AgentOpenFinish<T> | Promise<AgentOpenFinish<T>> {
    const decideAndRegister = (state: ProjectLimitState): AgentOpenFinish<T> => {
      if (opens() && decideOpen(state, deps.openCount()) !== 'allow') return refuseAgent(state)
      return { ok: true, value: register() }
    }
    const state = deps.getState()
    const d = decideOpen(state, deps.openCount())
    if (!opens() || !(d === 'claim' || reclaimsAtBlock(state, d))) return decideAndRegister(state)
    return claim().then((r) => decideAndRegister(r.state))
  }

  return { gateProjectOpen, checkAgentProjectOpen, finishAgentProjectOpen }
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

/** Run an agent's `open-project` registration under the limit, deciding and writing in one tick. */
export const finishAgentProjectOpen = liveGate.finishAgentProjectOpen
