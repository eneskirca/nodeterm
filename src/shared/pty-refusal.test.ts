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
})
