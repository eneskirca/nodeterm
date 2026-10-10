import { describe, expect, it } from 'vitest'
import { runQueuedNotice } from './boardRunQueued'

describe('runQueuedNotice', () => {
  it('a refusal shows its sentence without the agent-facing code', () => {
    expect(
      runQueuedNotice({ ok: false, error: 'run-not-mounted: n1 is on screen but its terminal is not mounted' }, 'dev')
    ).toEqual({ kind: 'error', text: 'Could not start "dev": n1 is on screen but its terminal is not mounted' })
  })
  it('a start raises nothing (the chip leaves the card)', () => {
    expect(runQueuedNotice({ ok: true, result: { started: true } }, 'dev')).toBeNull()
  })
  it('still queued says why', () => {
    expect(runQueuedNotice({ ok: true, result: { started: false, reason: 'no-shell' } }, 'dev')).toEqual({
      kind: 'info',
      text: '"dev" stays queued (no-shell).'
    })
  })
})
