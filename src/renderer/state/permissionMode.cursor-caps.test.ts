import { afterEach, describe, expect, it } from 'vitest'
import { cursorCliCapsNow, ensureCursorCliCaps, resetCursorCliCapsForTests } from './permissionMode'

// Review 2026-10-02: a failed or empty first probe (offline, signed out) was memoized forever, so
// the model menu stayed empty until an app reload even though core retries.
function stub(answers: { models: { id: string }[] }[]): { calls: number } {
  const seen = { calls: 0 }
  ;(globalThis as { window?: unknown }).window = {
    nodeTerminal: { cursor: { cliCaps: async () => answers[Math.min(seen.calls++, answers.length - 1)] } }
  }
  return seen
}

afterEach(() => resetCursorCliCapsForTests())

describe('cursor model catalogue memo', () => {
  it('retries after an empty answer and keeps the first real catalogue', async () => {
    const seen = stub([{ models: [] }, { models: [{ id: 'composer-2.5' }] }])
    expect((await ensureCursorCliCaps()).models).toEqual([])
    expect((await ensureCursorCliCaps()).models).toEqual([{ id: 'composer-2.5' }])
    await ensureCursorCliCaps()
    expect(seen.calls).toBe(2) // memoized once real
  })

  it('a synchronous read with nothing known starts the retry for the next menu open', async () => {
    const seen = stub([{ models: [{ id: 'composer-2.5' }] }])
    expect(cursorCliCapsNow().models).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.calls).toBe(1)
    expect(cursorCliCapsNow().models).toEqual([{ id: 'composer-2.5' }])
  })
})
