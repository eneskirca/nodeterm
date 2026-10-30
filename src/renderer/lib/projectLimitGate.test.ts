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

describe('DO_NOT_TRACK installs re-claim at a known allowance (the undo has no other way in)', () => {
  // A consenting DNT install that claimed is latched and holds a token, so `decideOpen` answers
  // 'block' at its allowance — and its check feed never runs, so without a claim at the limit it
  // would never hear `not_active` (an undo), an epoch bump or a raised FREE.
  const DNT_CLAIMED_5: ProjectLimitState = { ...CLAIMED_5, dnt: true }
  const DNT_OFF: ProjectLimitState = { ...INACTIVE, dnt: true }
  const MESSAGE = 'free plan: 5 of 5 projects are open; the user has been shown the options — do not retry'

  it('person: one claim at the limit, and a not_active answer opens with no dialog', async () => {
    const t = harness(DNT_CLAIMED_5, 5)
    t.claim.mockResolvedValue({ ok: true, state: DNT_OFF })
    const g = createProjectOpenGate(t.deps).gateProjectOpen()
    expect(g).toBeInstanceOf(Promise)
    await expect(g).resolves.toBe(true)
    expect(t.claim).toHaveBeenCalledTimes(1)
    expect(t.showDialog).not.toHaveBeenCalled()
  })

  it('person: the same allowance back shows the limit dialog after exactly one claim, never a loop', async () => {
    const t = harness(DNT_CLAIMED_5, 5)
    t.claim.mockResolvedValue({ ok: true, state: DNT_CLAIMED_5 })
    const g = createProjectOpenGate(t.deps).gateProjectOpen()
    await settle()
    expect(t.claim).toHaveBeenCalledTimes(1)
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    // A `proceed` with no room re-decides — still 'block' — and does not claim a second time.
    t.answer('proceed')
    await settle()
    expect(t.claim).toHaveBeenCalledTimes(1)
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
    expect(t.claim).toHaveBeenCalledTimes(1)
  })

  it('person: a re-claim that cannot reach the server is today\'s limit dialog, not "Couldn\'t check"', async () => {
    // The allowance is already known and verified offline (Review Focus 2): failing to hear an
    // undo is no reason to tell the user their allowance could not be checked.
    const t = harness(DNT_CLAIMED_5, 5)
    t.claim.mockResolvedValue({ ok: false, error: 'offline', state: DNT_CLAIMED_5 })
    const g = createProjectOpenGate(t.deps).gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
    expect(t.claim).toHaveBeenCalledTimes(1)
  })

  it('person: without consent the re-claim asks for it, exactly like a first claim', async () => {
    const t = harness(DNT_CLAIMED_5, 5)
    t.claim
      .mockResolvedValueOnce({ ok: false, error: 'consent_required', state: DNT_CLAIMED_5 })
      .mockResolvedValueOnce({ ok: true, state: DNT_OFF })
    const g = createProjectOpenGate(t.deps).gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'consent' }]])
    t.answer('consent')
    await expect(g).resolves.toBe(true)
    expect(t.setConsent).toHaveBeenCalledTimes(1)
    expect(t.claim).toHaveBeenCalledTimes(2)
    expect(t.showDialog).toHaveBeenCalledTimes(1)
  })

  it('person: declining that consent resolves false and stores nothing', async () => {
    const t = harness(DNT_CLAIMED_5, 5)
    t.claim.mockResolvedValue({ ok: false, error: 'consent_required', state: DNT_CLAIMED_5 })
    const g = createProjectOpenGate(t.deps).gateProjectOpen()
    await settle()
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
    expect(t.setConsent).not.toHaveBeenCalled()
    expect(t.claim).toHaveBeenCalledTimes(1)
  })

  it('a non-DNT install at a known allowance never re-claims: it hears the undo on the check feed', async () => {
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const g = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.answer('cancel')
    await expect(g).resolves.toBe(false)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(gate.finishAgentProjectOpen(() => true, () => 'never')).toEqual({ ok: false, message: MESSAGE })
    expect(t.claim).not.toHaveBeenCalled()
  })

  it('a DNT install under its allowance still opens synchronously, with no claim', () => {
    const t = harness(DNT_CLAIMED_5, 4)
    expect(createProjectOpenGate(t.deps).gateProjectOpen()).toBe(true)
    expect(t.claim).not.toHaveBeenCalled()
  })

  it('agent check: one claim at the limit; not_active allows, the same allowance refuses, consent is never asked', async () => {
    const t = harness(DNT_CLAIMED_5, 5)
    t.claim.mockResolvedValueOnce({ ok: true, state: DNT_OFF })
    const gate = createProjectOpenGate(t.deps)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: true })
    expect(t.claim).toHaveBeenCalledTimes(1)

    t.claim.mockResolvedValueOnce({ ok: true, state: DNT_CLAIMED_5 })
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.claim).toHaveBeenCalledTimes(2)
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.answer('cancel')
    await settle()

    t.claim.mockResolvedValueOnce({ ok: false, error: 'consent_required', state: DNT_CLAIMED_5 })
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.claim).toHaveBeenCalledTimes(3)
    expect(t.showDialog.mock.calls.some(([r]) => r.mode === 'consent')).toBe(false)
    expect(t.setConsent).not.toHaveBeenCalled()
    expect(t.setChecking).not.toHaveBeenCalled()
  })

  it('agent write: one claim at the limit, registered on not_active, refused on the same allowance', async () => {
    const t = harness(DNT_CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const register = vi.fn(() => 'registered')
    t.claim.mockResolvedValueOnce({ ok: true, state: DNT_OFF })
    const off = gate.finishAgentProjectOpen(() => true, register)
    expect(off).toBeInstanceOf(Promise)
    await expect(off).resolves.toEqual({ ok: true, value: 'registered' })
    expect(t.claim).toHaveBeenCalledTimes(1)

    register.mockClear()
    t.claim.mockResolvedValueOnce({ ok: false, error: 'consent_required', state: DNT_CLAIMED_5 })
    await expect(gate.finishAgentProjectOpen(() => true, register)).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(t.claim).toHaveBeenCalledTimes(2)
    expect(register).not.toHaveBeenCalled()
    expect(t.setConsent).not.toHaveBeenCalled()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
  })
})

describe('checkAgentProjectOpen — the agent open-project verb', () => {
  const MESSAGE = 'free plan: 5 of 5 projects are open; the user has been shown the options — do not retry'

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
      message: 'free plan: 7 of 7 projects are open; the user has been shown the options — do not retry'
    })
  })
})

describe('finishAgentProjectOpen — the final decision and the agent registration, in one tick', () => {
  const MESSAGE = 'free plan: 5 of 5 projects are open; the user has been shown the options — do not retry'
  const CLAIMED_12: ProjectLimitState = { ...AT_LIMIT, allowance: 12 }

  /** A register callback that counts its calls and, like registerProject, adds an open project. */
  function registrar(t: Harness, open: { n: number }) {
    return vi.fn(() => {
      open.n += 1
      t.setOpen(open.n)
      return `registered #${open.n}`
    })
  }

  it('allows and registers in the same tick, with no claim and no dialog, whenever a person would be allowed', () => {
    for (const [state, n] of [
      [INACTIVE, 9],
      [PRO, 9],
      [CLAIMED_5, 4],
      [AT_LIMIT, 4]
    ] as const) {
      const t = harness(state, n)
      const register = registrar(t, { n })
      // A plain object, not a promise: the write has already happened when the call returns.
      expect(createProjectOpenGate(t.deps).finishAgentProjectOpen(() => true, register)).toEqual({
        ok: true,
        value: `registered #${n + 1}`
      })
      expect(register).toHaveBeenCalledTimes(1)
      expect(t.claim).not.toHaveBeenCalled()
      expect(t.showDialog).not.toHaveBeenCalled()
    }
  })

  it('a registration that opens nothing new is never refused, even past the limit', () => {
    const t = harness(CLAIMED_5, 7)
    const register = vi.fn(() => 'hit')
    expect(createProjectOpenGate(t.deps).finishAgentProjectOpen(() => false, register)).toEqual({
      ok: true,
      value: 'hit'
    })
    expect(t.showDialog).not.toHaveBeenCalled()
  })

  it('refuses at a known allowance synchronously, with the async check’s message, and writes nothing', async () => {
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const register = vi.fn(() => 'never')
    expect(gate.finishAgentProjectOpen(() => true, register)).toEqual({ ok: false, message: MESSAGE })
    expect(register).not.toHaveBeenCalled()
    expect(t.claim).not.toHaveBeenCalled()
    t.answer('cancel')
    await settle()
    t.setNow(1_000_000 + AGENT_DIALOG_QUIET_MS)
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: false, message: MESSAGE })
  })

  it('two agents at the edge end at the limit, not past it (Review Focus 5)', async () => {
    const t = harness(CLAIMED_5, 4)
    const open = { n: 4 }
    const register = registrar(t, open)
    const gate = createProjectOpenGate(t.deps)
    // Both pass the early check while the user is still answering their confirm dialogs.
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: true })
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: true })
    expect(gate.finishAgentProjectOpen(() => true, register)).toEqual({ ok: true, value: 'registered #5' })
    // The second is refused at the store write instead of making a sixth.
    expect(gate.finishAgentProjectOpen(() => true, register)).toEqual({ ok: false, message: MESSAGE })
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('a claim the early check never made: due at the write, claimed there, registered on a high allowance', async () => {
    const t = harness(AT_LIMIT, 4)
    const gate = createProjectOpenGate(t.deps)
    // At 4 of 5 with no allowance yet the early check allows without claiming.
    await expect(gate.checkAgentProjectOpen()).resolves.toEqual({ ok: true })
    expect(t.claim).not.toHaveBeenCalled()
    // A fifth project opens while the user answers the confirm dialog.
    t.setOpen(5)
    const open = { n: 5 }
    const register = registrar(t, open)
    // The claim's answer is decided on directly: the store has not heard it (`getState` still
    // answers AT_LIMIT), exactly as for the other two paths.
    t.claim.mockResolvedValue({ ok: true, state: CLAIMED_12 })
    const finished = gate.finishAgentProjectOpen(() => true, register)
    expect(finished).toBeInstanceOf(Promise)
    expect(register).not.toHaveBeenCalled()
    await expect(finished).resolves.toEqual({ ok: true, value: 'registered #6' })
    expect(t.claim).toHaveBeenCalledTimes(1)
    expect(t.showDialog).not.toHaveBeenCalled()
    expect(t.setChecking).not.toHaveBeenCalled()
  })

  it('a claim the early check never made: refused with the message when the claim leaves it at 5', async () => {
    const t = harness(AT_LIMIT, 5)
    const gate = createProjectOpenGate(t.deps)
    const register = vi.fn(() => 'never')
    t.claim.mockResolvedValue({ ok: true, state: CLAIMED_5 })
    await expect(gate.finishAgentProjectOpen(() => true, register)).resolves.toEqual({ ok: false, message: MESSAGE })
    expect(register).not.toHaveBeenCalled()
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    // A failed claim (or one that needs consent) is a refusal too — never the consent dialog.
    const u = harness({ ...AT_LIMIT, dnt: true }, 5)
    u.claim.mockResolvedValue({ ok: false, error: 'consent_required', state: { ...AT_LIMIT, dnt: true } })
    await expect(createProjectOpenGate(u.deps).finishAgentProjectOpen(() => true, register)).resolves.toEqual({
      ok: false,
      message: MESSAGE
    })
    expect(u.setConsent).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('two claims at the edge: the decision and the write share one tick, so only one registers', async () => {
    // 5 open, no allowance; both claims answer 6. Were there a yield between deciding and
    // registering, both would decide on 5 < 6 and the canvas would end at 7.
    const t = harness(AT_LIMIT, 5)
    const open = { n: 5 }
    const register = registrar(t, open)
    const gate = createProjectOpenGate(t.deps)
    const answer = deferred<ClaimResult>()
    t.claim.mockReturnValue(answer.promise)
    const a = gate.finishAgentProjectOpen(() => true, register)
    const b = gate.finishAgentProjectOpen(() => true, register)
    answer.resolve({ ok: true, state: { ...AT_LIMIT, allowance: 6 } })
    await expect(a).resolves.toEqual({ ok: true, value: 'registered #6' })
    await expect(b).resolves.toEqual({
      ok: false,
      message: 'free plan: 6 of 6 projects are open; the user has been shown the options — do not retry'
    })
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('opens is asked at the final decision: a project opened meanwhile is a hit, not a refusal', async () => {
    const t = harness(AT_LIMIT, 5)
    let opens = true
    const answer = deferred<ClaimResult>()
    t.claim.mockReturnValue(answer.promise)
    const register = vi.fn(() => 'hit')
    const finished = createProjectOpenGate(t.deps).finishAgentProjectOpen(() => opens, register)
    // The user reopens that very project by hand while the claim is in flight.
    opens = false
    answer.resolve({ ok: true, state: CLAIMED_5 })
    await expect(finished).resolves.toEqual({ ok: true, value: 'hit' })
  })

  it('shows the user the dialog under the same rules as the async check: once per quiet window', async () => {
    const t = harness(CLAIMED_5, 5)
    const gate = createProjectOpenGate(t.deps)
    const register = vi.fn(() => 'never')
    gate.finishAgentProjectOpen(() => true, register)
    expect(t.showDialog.mock.calls).toEqual([[{ mode: 'limit' }]])
    t.answer('cancel')
    await settle()
    // Inside the window — whichever check refuses next — the user is not shown it again.
    t.setNow(1_000_000 + AGENT_DIALOG_QUIET_MS - 1)
    await gate.checkAgentProjectOpen()
    gate.finishAgentProjectOpen(() => true, register)
    expect(t.showDialog).toHaveBeenCalledTimes(1)
    // And never stacked on a dialog that is already up.
    t.setNow(1_000_000 + AGENT_DIALOG_QUIET_MS)
    const human = gate.gateProjectOpen()
    await settle()
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    gate.finishAgentProjectOpen(() => true, register)
    expect(t.showDialog).toHaveBeenCalledTimes(2)
    t.answer('cancel')
    await expect(human).resolves.toBe(false)
    expect(register).not.toHaveBeenCalled()
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
