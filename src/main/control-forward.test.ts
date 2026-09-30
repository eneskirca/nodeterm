import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createControlForwarder, controlTimeoutError } from './control-forward'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createControlForwarder', () => {
  it('resolves with the renderer answer that carries its request id', async () => {
    const sent: string[] = []
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-agent', (id) => sent.push(id))
    fwd.answer({ requestId: sent[0], ok: true, message: 'opened n1' })
    await expect(p).resolves.toEqual({ ok: true, message: 'opened n1' })
  })

  it('a timeout is INDETERMINATE: the renderer may still do it, so nobody may claim it did not happen', async () => {
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-worktree', () => {})
    vi.advanceTimersByTime(1000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.indeterminate).toBe(true)
  })

  it('an answer that arrives after the timeout is handed to the late-answer callback, once', async () => {
    const sent: string[] = []
    const late = vi.fn()
    const fwd = createControlForwarder({ timeoutMs: 1000, lateWindowMs: 60_000 })
    const p = fwd.forward('open-worktree', (id) => sent.push(id), { onLate: late })
    vi.advanceTimersByTime(1000)
    await p
    fwd.answer({ requestId: sent[0], ok: true, message: 'opened worktree feat-x' })
    fwd.answer({ requestId: sent[0], ok: true, message: 'a duplicate answer' })
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith({ ok: true, message: 'opened worktree feat-x' })
  })

  it('forgets a late answer past its window, and never calls a callback nobody registered', async () => {
    const sent: string[] = []
    const late = vi.fn()
    const fwd = createControlForwarder({ timeoutMs: 1000, lateWindowMs: 5000 })
    const p = fwd.forward('open-terminal', (id) => sent.push(id), { onLate: late })
    vi.advanceTimersByTime(1000)
    await p
    vi.advanceTimersByTime(5000)
    fwd.answer({ requestId: sent[0], ok: true, message: 'too late' })
    expect(late).not.toHaveBeenCalled()
    // No callback: a late answer is dropped exactly as before.
    const q = fwd.forward('open-terminal', (id) => sent.push(id))
    vi.advanceTimersByTime(1000)
    await q
    expect(() => fwd.answer({ requestId: sent[1], ok: true })).not.toThrow()
  })

  it('an answer for an unknown request id is ignored', () => {
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    expect(() => fwd.answer({ requestId: 'nope', ok: true })).not.toThrow()
  })

  // The post-processing main does with an answer (recording who owns an opened browser, a project
  // grant) must run on the answer the caller is eventually TOLD about — which, after a timeout, is
  // the late one the request ledger replays. Skipping it there replayed "opened browser b1" for a
  // browser nobody owned, so the agent could never drive it.
  it('runs `finish` on an on-time answer and returns what it returns', async () => {
    const sent: string[] = []
    const finish = vi.fn((r: { ok: boolean; message?: string }) => ({ ...r, message: `${r.message} (finished)` }))
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-browser', (id) => sent.push(id), { finish })
    fwd.answer({ requestId: sent[0], ok: true, message: 'opened b1' })
    await expect(p).resolves.toEqual({ ok: true, message: 'opened b1 (finished)' })
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('runs `finish` on a LATE answer before handing it back, and never on the timeout itself', async () => {
    const sent: string[] = []
    const finish = vi.fn((r: { ok: boolean; message?: string }) => ({ ...r, message: `${r.message} (finished)` }))
    const late = vi.fn()
    const fwd = createControlForwarder({ timeoutMs: 1000 })
    const p = fwd.forward('open-browser', (id) => sent.push(id), { onLate: late, finish })
    vi.advanceTimersByTime(1000)
    expect((await p).indeterminate).toBe(true)
    expect(finish).not.toHaveBeenCalled()
    fwd.answer({ requestId: sent[0], ok: true, message: 'opened b1' })
    expect(finish).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith({ ok: true, message: 'opened b1 (finished)' })
  })

  // Review NIT on #1033: `finish` runs after the pending entry is gone. A throw there used to escape
  // into the IPC listener with `resolve` never called — the route's handler hung, and its ledger row
  // sat in flight until stale. The answer existed, so the effect may have happened: indeterminate.
  it('a finishing step that throws on an on-time answer resolves INDETERMINATE instead of hanging', async () => {
    const sent: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fwd = createControlForwarder({ timeoutMs: 1000 })
      const p = fwd.forward('open-browser', (id) => sent.push(id), {
        onLate: () => {},
        finish: () => {
          throw new Error('ledger exploded')
        }
      })
      expect(() => fwd.answer({ requestId: sent[0], ok: true, message: 'opened b1' })).not.toThrow()
      const r = await p
      expect(r.ok).toBe(false)
      expect(r.indeterminate).toBe(true)
      expect(r.error).toMatch(/may have taken effect/)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a finishing step that throws on a LATE answer hands nothing back and does not throw', async () => {
    const sent: string[] = []
    const late = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fwd = createControlForwarder({ timeoutMs: 1000 })
      const p = fwd.forward('open-browser', (id) => sent.push(id), {
        onLate: late,
        finish: () => {
          throw new Error('ledger exploded')
        }
      })
      vi.advanceTimersByTime(1000)
      await p
      expect(() => fwd.answer({ requestId: sent[0], ok: true, message: 'opened b1' })).not.toThrow()
      // The row stays unknown: an answer main could not finish is not one to replay.
      expect(late).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('without a request-id claim, a timed-out open is told to check the canvas — never pointed at a flag', async () => {
    const fwd = createControlForwarder({ timeoutMs: 120_000 })
    const p = fwd.forward('open-agent', () => {})
    vi.advanceTimersByTime(120_000)
    const r = await p
    expect(r.error).toMatch(/check the canvas for its effect before retrying/)
    expect(r.error).not.toMatch(/--request-id/)
  })
})

describe('controlTimeoutError', () => {
  it('a confirm-gated verb keeps its dialog wording: the dialog dismisses itself at the same deadline', () => {
    expect(controlTimeoutError('write', 120_000, false)).toBe(
      'no answer within 120s — the confirmation dialog has been dismissed; safe to retry'
    )
  })

  it('with a claim, says the call may have taken effect and leaves the id to the route that holds it', () => {
    const msg = controlTimeoutError('open-worktree', 120_000, true)
    expect(msg).toMatch(/^no answer within 120s/)
    expect(msg).not.toMatch(/safe to retry/)
    expect(msg).toMatch(/may still complete/)
    // The forwarder never sees the id; printing a flag with no value to pass is how an agent came to
    // re-run the bare command and open a second one.
    expect(msg).not.toMatch(/--request-id/)
  })

  it('without a claim, every verb gets the generic check-the-canvas sentence', () => {
    for (const verb of ['open-worktree', 'open-agent', 'rename']) {
      const msg = controlTimeoutError(verb, 120_000, false)
      expect(msg, verb).not.toMatch(/safe to retry/)
      expect(msg, verb).not.toMatch(/--request-id/)
      expect(msg, verb).toMatch(/may still complete; check the canvas for its effect before retrying/)
    }
  })
})
