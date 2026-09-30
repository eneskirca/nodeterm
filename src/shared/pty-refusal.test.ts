import { describe, expect, it } from 'vitest'
import { ptyRefusal } from './pty-refusal'

describe('PTY refusal presentation', () => {
  it('does not disconnect a healthy SSH project for an account refusal', () => {
    expect(ptyRefusal('codex-account')).toMatchObject({ connectionLost: false })
    expect(ptyRefusal('codex-account').message).toContain('SSH managed accounts are not supported yet')
  })
  it('retains reconnect behavior for an SSH refusal', () => {
    expect(ptyRefusal('ssh')).toEqual({ connectionLost: true, message: 'not connected — nothing was started locally' })
  })
  // A hosted-relay viewer asked to watch a terminal nobody has open. Nothing is disconnected: read
  // as `connectionLost`, the card modal would report an SSH drop and kick the reconnector for it.
  it('a join-only refusal is not a lost connection, and says why nothing is shown', () => {
    expect(ptyRefusal('join-only')).toEqual({
      connectionLost: false,
      message: 'no running terminal was found to watch — a viewer can only watch terminals that are already open'
    })
  })
  // The same refusal covers "tmux said it is gone" AND "tmux could not be asked", so the sentence
  // must not assert the first: a probe that failed says nothing about whether the terminal runs.
  it('the join-only message does not claim the terminal is not running', () => {
    expect(ptyRefusal('join-only').message).not.toMatch(/is not running/)
  })
})
