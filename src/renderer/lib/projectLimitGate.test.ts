import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimResult, ProjectLimitState } from '@shared/project-limit'

// The real bindings below import the project-limit store, which subscribes to
// `window.nodeTerminal.projectLimit.onChange` at import time — so the bridge must exist before any
// import runs. The settings and projects stores are replaced: the bound deps only need
// `useSettings.getState().{update,flush}` and `useProjects.getState().projects` from them.
const h = vi.hoisted(() => {
  const claim = vi.fn()
  const update = vi.fn()
  const flush = vi.fn()
  const box: { projects: { closed?: boolean; remote?: boolean }[] } = { projects: [] }
  vi.stubGlobal('window', {
    nodeTerminal: {
      projectLimit: {
        state: vi.fn(),
        claim,
        onChange: () => () => {}
      }
    }
  })
  return { claim, update, flush, box }
})
vi.mock('../state/settings', () => ({
  useSettings: { getState: () => ({ update: h.update, flush: h.flush }) }
}))
vi.mock('../state/projects', () => ({
  useProjects: { getState: () => ({ projects: h.box.projects }) }
}))

import {
  AGENT_DIALOG_QUIET_MS,
  CHECKING_DELAY_MS,
  createProjectOpenGate,
  liveProjectOpenGateDeps,
  type ProjectOpenGateDeps
} from './projectLimitGate'
import { useProjectLimit, type DialogOutcome, type LimitDialogRequest } from '../state/projectLimit'

afterAll(() => {
  vi.unstubAllGlobals()
})

const INACTIVE: ProjectLimitState = { active: false, pro: false, free: 5, allowance: null, dnt: false }
const AT_LIMIT: ProjectLimitState = { active: true, pro: false, free: 5, allowance: null, dnt: false }
const CLAIMED_5: ProjectLimitState = { ...AT_LIMIT, allowance: 5 }
const CLAIMED_7: ProjectLimitState = { ...AT_LIMIT, allowance: 7 }
const PRO: ProjectLimitState = { ...AT_LIMIT, pro: true }

/** A promise whose settlement the test controls. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every queued microtask (and the gate's chained awaits) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

interface Harness {
  deps: ProjectOpenGateDeps
  claim: ReturnType<typeof vi.fn<() => Promise<ClaimResult>>>
  setConsent: ReturnType<typeof vi.fn<() => Promise<void>>>
  setChecking: ReturnType<typeof vi.fn<(on: boolean) => void>>
  showDialog: ReturnType<typeof vi.fn<(r: LimitDialogRequest) => Promise<DialogOutcome>>>
  /** Resolve the dialog currently shown (the latest `showDialog` call). */
  answer(o: DialogOutcome): void
  set(s: ProjectLimitState): void
  setOpen(n: number): void
  setNow(ms: number): void
}

function harness(initial: ProjectLimitState, open: number): Harness {
  let state = initial
  let openCount = open
  let now = 1_000_000
  const pending: ((o: DialogOutcome) => void)[] = []
  const claim = vi.fn<() => Promise<ClaimResult>>()
  const setConsent = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const setChecking = vi.fn<(on: boolean) => void>()
  const showDialog = vi.fn<(r: LimitDialogRequest) => Promise<DialogOutcome>>(
    () => new Promise<DialogOutcome>((resolve) => pending.push(resolve))
  )
  return {
    deps: {
      getState: () => state,
      openCount: () => openCount,
      claim,
      setConsent,
      showDialog,
      setChecking,
      now: () => now
    },
    claim,
    setConsent,
    setChecking,
    showDialog,
    answer(o) {
      const r = pending.pop()
      if (!r) throw new Error('no dialog is open')
      r(o)
    },
    set(s) {
      state = s
    },
    setOpen(n) {
      openCount = n
    },
    setNow(ms) {
      now = ms
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('gateProjectOpen — the human open path', () => {
  it('allows synchronously when inactive', () => {
    // Dormant day one (Review Focus 1): nine open, a tenth must open exactly as today — the literal
    // `true`, returned in the same tick, with no claim, no spinner and no modal.
    const t = harness(INACTIVE, 9)
    const gate = createProjectOpenGate(t.deps)
    expect(gate.gateProjectOpen()).toBe(true)
    // DNT changes nothing while the limit is off.
    t.set({ ...INACTIVE, dnt: true })
    expect(gate.gateProjectOpen()).toBe(true)
    expect(t.claim).not.toHaveBeenCalled()
    expect(t.showDialog).not.toHaveBeenCalled()
    expect(t.setChecking).not.toHaveBeenCalled()
  })

  it('allows synchronously for pro and under the limit', () => {
    const t = harness(PRO, 40)
    const gate = createProjectOpenGate(t.deps)
    expect(gate.gateProjectOpen()).toBe(true)
    t.set(AT_LIMIT)
    t.setOpen(4)
    expect(gate.gateProjectOpen()).toBe(true)
    t.set(CLAIMED_7)
    t.setOpen(6)
    expect(gate.gateProjectOpen()).toBe(true)
    expect(t.claim).not.toHaveBeenCalled()
    expect(t.showDialog).not.toHaveBeenCalled()
  })

  it('claims at the limit, then allows if the allowance permits', async () => {
    const t = harness(AT_LIMIT, 5)
    t.claim.mockResolvedValue({ ok: true, state: CLAIMED_7 })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    expect(g).toBeInstanceOf(Promise)
    await expect(g).resolves.toBe(true)
    expect(t.claim).toHaveBeenCalledTimes(1)
    expect(t.showDialog).not.toHaveBeenCalled()
  })

  it('shows checking only when the claim outlasts 300 ms', async () => {
    vi.useFakeTimers()
    const t = harness(AT_LIMIT, 5)
    const slow = deferred<ClaimResult>()
    t.claim.mockReturnValueOnce(slow.promise)
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await vi.advanceTimersByTimeAsync(CHECKING_DELAY_MS - 1)
    expect(t.setChecking).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.setChecking.mock.calls).toEqual([[true]])
    slow.resolve({ ok: true, state: CLAIMED_7 })
    await expect(g).resolves.toBe(true)
    expect(t.setChecking.mock.calls).toEqual([[true], [false]])

    // A fast claim never raises the spinner — not even for a frame.
    const u = harness(AT_LIMIT, 5)
    u.claim.mockResolvedValue({ ok: true, state: CLAIMED_7 })
    const fast = createProjectOpenGate(u.deps).gateProjectOpen()
    await vi.advanceTimersByTimeAsync(CHECKING_DELAY_MS * 3)
    await expect(fast).resolves.toBe(true)
    expect(u.setChecking).not.toHaveBeenCalledWith(true)
  })

  it('shows the limit dialog when still at the limit; cancel resolves false', async () => {
    const t = harness(AT_LIMIT, 5)
    t.claim.mockResolvedValue({ ok: true, state: CLAIMED_5 })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
    expect(t.claim).toHaveBeenCalledTimes(1)
  })

  it('proceed after a Close resolves true', async () => {
    // A known allowance at the limit blocks without asking the server again.
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.claim).not.toHaveBeenCalled()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.setOpen(4) // the user pressed Close on one row
    t.answer('proceed')
    await expect(g).resolves.toBe(true)
  })

  it('proceed is re-decided, never trusted: still at the limit shows the dialog again', async () => {
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    // Something else filled the freed slot before the gate looked again.
    t.answer('proceed')
    await settle()
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
  })

  it('a claim error shows the error dialog; retry claims again', async () => {
    const t = harness(AT_LIMIT, 5)
    t.claim
      .mockResolvedValueOnce({ ok: false, error: 'offline', state: AT_LIMIT })
      .mockResolvedValueOnce({ ok: true, state: CLAIMED_7 })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'error' }]])
    t.answer('retry')
    await expect(g).resolves.toBe(true)
    expect(t.claim).toHaveBeenCalledTimes(2)
    expect(t.showDialog).toHaveBeenCalledTimes(1)
  })

  it('a rejected claim is an offline claim, not a thrown open', async () => {
    const t = harness(AT_LIMIT, 5)
    t.claim.mockRejectedValueOnce(new Error('No handler registered for projectLimit:claim'))
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'error' }]])
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
  })

  it('machine_mismatch shows the mismatch dialog with retryAfter', async () => {
    const t = harness(AT_LIMIT, 5)
    t.claim.mockResolvedValue({ ok: false, error: 'machine_mismatch', retryAfter: 1_800_000_000, state: AT_LIMIT })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'mismatch', retryAfter: 1_800_000_000 }]])
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
  })

  it('consent_required asks consent, stores it, then claims', async () => {
    const t = harness({ ...AT_LIMIT, dnt: true }, 5)
    const stored = deferred<void>()
    t.setConsent.mockReturnValueOnce(stored.promise)
    t.claim
      .mockResolvedValueOnce({ ok: false, error: 'consent_required', state: { ...AT_LIMIT, dnt: true } })
      .mockResolvedValueOnce({ ok: true, state: { ...CLAIMED_7, dnt: true } })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'consent' }]])
    t.answer('consent')
    await settle()
    expect(t.setConsent).toHaveBeenCalledTimes(1)
    // The second claim waits for the consent to be stored: core reads it, not the renderer.
    expect(t.claim).toHaveBeenCalledTimes(1)
    stored.resolve()
    await expect(g).resolves.toBe(true)
    expect(t.claim).toHaveBeenCalledTimes(2)
    expect(t.showDialog).toHaveBeenCalledTimes(1)
  })

  it('a declined consent resolves false and stores nothing', async () => {
    const t = harness({ ...AT_LIMIT, dnt: true }, 5)
    t.claim.mockResolvedValue({ ok: false, error: 'consent_required', state: { ...AT_LIMIT, dnt: true } })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
    expect(t.setConsent).not.toHaveBeenCalled()
    expect(t.claim).toHaveBeenCalledTimes(1)
  })

  it('consent that core still does not see shows the error dialog, not the consent dialog again', async () => {
    const t = harness({ ...AT_LIMIT, dnt: true }, 5)
    t.claim.mockResolvedValue({ ok: false, error: 'consent_required', state: { ...AT_LIMIT, dnt: true } })
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    t.answer('consent')
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'consent' }], [{ mode: 'error' }]])
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
  })

  it('refuses a second request while the dialog is open', async () => {
    // Review Focus 5: a second open at the edge is refused, never queued behind the first.
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const first = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog).toHaveBeenCalledTimes(1)
    const second = gate.gateProjectOpen()
    expect(second).toBeInstanceOf(Promise)
    await expect(second).resolves.toBe(false)
    expect(t.showDialog).toHaveBeenCalledTimes(1)
    t.answer('cancel')
    await expect(first).resolves.toBe(false)
    // Not stuck: once the dialog is gone the next open is asked again.
    const third = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    t.answer('cancel')
    await expect(third).resolves.toBe(false)
  })

  it('refuses a second request while the first one is still claiming', async () => {
    // Both would otherwise re-decide on the same count and both open: one past an allowance of 6.
    const t = harness(AT_LIMIT, 5)
    const slow = deferred<ClaimResult>()
    t.claim.mockReturnValueOnce(slow.promise)
    const gate = createProjectOpenGate(t.deps)
    const first = gate.gateProjectOpen()
    await settle()
    await expect(gate.gateProjectOpen()).resolves.toBe(false)
    expect(t.claim).toHaveBeenCalledTimes(1)
    slow.resolve({ ok: true, state: { ...AT_LIMIT, allowance: 6 } })
    await expect(first).resolves.toBe(true)
  })
})

describe('checkAgentProjectOpen — the agent open-project verb', () => {
  const MESSAGE = 'free plan: 5 of 5 projects are open; the user has been shown the options'

  it('allows when the open would be allowed for a person, without any dialog', async () => {
    const t = harness(INACTIVE, 9)
    const gate = createProjectOpenGate(t.deps)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: true })
    t.set(AT_LIMIT)
    t.claim.mockResolvedValue({ ok: true, state: CLAIMED_7 })
    t.setOpen(5)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: true })
    expect(t.showDialog).not.toHaveBeenCalled()
  })

  it('agent: refuses with the message and shows the dialog once per 60 s', async () => {
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.answer('cancel')
    await settle()
    // The agent retries inside the quiet window: refused, and the user is not shown it again.
    t.setNow(1_000_000 + AGENT_DIALOG_QUIET_MS - 1)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.showDialog).toHaveBeenCalledTimes(1)
    // A minute after it was shown, the next refusal shows it once more.
    t.setNow(1_000_000 + AGENT_DIALOG_QUIET_MS)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    expect(t.claim).not.toHaveBeenCalled()
  })

  it('agent: never stacks a dialog on one that is already open', async () => {
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    // A person's open is already showing the limit dialog.
    const human = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog).toHaveBeenCalledTimes(1)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.showDialog).toHaveBeenCalledTimes(1)
    t.answer('cancel')
    await expect(human).resolves.toBe(false)
    // An agent's own dialog blocks a person's open the same way (one dialog at a time).
    await gate.checkAgentProjectOpen()
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    await expect(gate.gateProjectOpen()).resolves.toBe(false)
    expect(t.showDialog).toHaveBeenCalledTimes(2)
  })

  it('agent: never asks for consent', async () => {
    const t = harness({ ...AT_LIMIT, dnt: true }, 5)
    t.claim.mockResolvedValue({ ok: false, error: 'consent_required', state: { ...AT_LIMIT, dnt: true } })
    const gate = createProjectOpenGate(t.deps)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    expect(t.setConsent).not.toHaveBeenCalled()
    expect(t.setChecking).not.toHaveBeenCalled()
  })

  it('agent: the message carries the allowance, not FREE', async () => {
    const t = harness(AT_LIMIT, 7)
    t.claim.mockResolvedValue({ ok: true, state: CLAIMED_7 })
    const gate = createProjectOpenGate(t.deps)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({
      ok: false,
      message: 'free plan: 7 of 7 projects are open; the user has been shown the options'
    })
  })
})

describe('the live bindings', () => {
  beforeEach(() => {
    h.claim.mockReset()
    h.update.mockReset()
    h.flush.mockReset()
    h.box.projects = []
    useProjectLimit.setState({ dialog: null, checking: false })
  })

  it('setConsent publishes the setting before it resolves', async () => {
    // `update` only schedules a coalesced save (300 ms): a claim fired right after it would reach a
    // core that has not seen the consent and answer consent_required again.
    const saved = deferred<void>()
    h.flush.mockReturnValue(saved.promise)
    let done = false
    const p = liveProjectOpenGateDeps.setConsent().then(() => {
      done = true
    })
    await settle()
    expect(h.update).toHaveBeenCalledWith({ licenseNetworkConsent: true })
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.flush.mock.invocationCallOrder[0])
    expect(done).toBe(false)
    saved.resolve()
    await p
    expect(done).toBe(true)
  })

  it('openCount is the one definition: not closed, not a relay tab', () => {
    h.box.projects = [{}, { closed: true }, { remote: true }, { closed: false, remote: false }]
    expect(liveProjectOpenGateDeps.openCount()).toBe(2)
  })

  it('claim asks core over the bridge', async () => {
    h.claim.mockResolvedValue({ ok: true, state: CLAIMED_7 })
    await expect(liveProjectOpenGateDeps.claim()).resolves.toEqual({ ok: true, state: CLAIMED_7 })
  })

  it('showDialog is the store dialog, settled by resolveDialog', async () => {
    const p = liveProjectOpenGateDeps.showDialog({ mode: 'mismatch', retryAfter: 9 })
    expect(useProjectLimit.getState().dialog).toEqual({ mode: 'mismatch', retryAfter: 9 })
    useProjectLimit.getState().resolveDialog('retry')
    await expect(p).resolves.toBe('retry')
    expect(useProjectLimit.getState().dialog).toBeNull()
  })

  it('setChecking toggles the store spinner flag', () => {
    liveProjectOpenGateDeps.setChecking(true)
    expect(useProjectLimit.getState().checking).toBe(true)
    liveProjectOpenGateDeps.setChecking(false)
    expect(useProjectLimit.getState().checking).toBe(false)
  })

  it('getState reads the store', () => {
    useProjectLimit.setState({ state: CLAIMED_7 })
    expect(liveProjectOpenGateDeps.getState()).toEqual(CLAIMED_7)
  })
})
