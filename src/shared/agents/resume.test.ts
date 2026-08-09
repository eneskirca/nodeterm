import { describe, it, expect } from 'vitest'
import { resumeCommand } from './config'

describe('resumeCommand', () => {
  it('builds claude resume', () => {
    expect(resumeCommand('claude', 'abc-123')).toBe('claude --resume abc-123')
  })

  it('builds codex resume (subcommand form)', () => {
    expect(resumeCommand('codex', 'abc-123')).toBe('codex resume abc-123')
  })

  it('builds gemini resume', () => {
    expect(resumeCommand('gemini', 'abc-123')).toBe('gemini --resume abc-123')
  })

  it('returns null for a non-resumable / custom agent', () => {
    expect(resumeCommand('custom:xyz', 'abc-123')).toBeNull()
  })

  it('returns null when the session id is missing or empty', () => {
    expect(resumeCommand('claude', '')).toBeNull()
    expect(resumeCommand('claude', '   ')).toBeNull()
  })

  it('rejects an unsafe session id (shell metacharacters / flag-like)', () => {
    expect(resumeCommand('claude', '-rf /')).toBeNull()
    expect(resumeCommand('claude', 'a; rm -rf /')).toBeNull()
    expect(resumeCommand('claude', 'a$(whoami)')).toBeNull()
    expect(resumeCommand('claude', 'a b')).toBeNull()
  })

  it('resumes opencode via --session', () => {
    expect(resumeCommand('opencode', 'ses_a1b2c3')).toBe('opencode --session ses_a1b2c3')
  })
  it('rejects an unsafe opencode session id', () => {
    expect(resumeCommand('opencode', 'x; rm -rf /')).toBeNull()
  })
})

/**
 * Grok's entry was read off the SHIPPED BINARY (`@xai-official/grok`, `grok --help`) rather than
 * from a README or from the shape of the agents beside it — `-r, --resume [<SESSION_ID>]`, the same
 * spelling claude and gemini use, which is why it shares their branch instead of getting its own.
 */
describe('resumeCommand — grok', () => {
  it('builds grok resume', () => {
    expect(resumeCommand('grok', 'abc-123')).toBe('grok --resume abc-123')
  })
})
