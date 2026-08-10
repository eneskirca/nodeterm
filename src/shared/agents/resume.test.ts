import { describe, it, expect } from 'vitest'
import { resumeCommand, withSessionId } from './config'

describe('withSessionId', () => {
  it('appends the minted id for claude', () => {
    expect(withSessionId('claude', 'claude', 'abc-123')).toBe('claude --session-id abc-123')
  })

  it('leaves a non-capable agent byte-identical', () => {
    for (const id of ['codex', 'gemini', 'grok', 'opencode'] as const) {
      expect(withSessionId(id, id, 'abc-123')).toBe(id)
    }
  })

  // The value reaches a tmux send-keys line, so the type is not the guard — the same reason
  // resumeCommand re-validates. A rejected id must yield the bare command, never a broken one.
  it('refuses an unsafe or empty id and returns the command unchanged', () => {
    for (const bad of ['', '   ', '-rf', 'a; rm -rf /', '$(id)', 'a b']) {
      expect(withSessionId('claude', 'claude', bad)).toBe('claude')
    }
  })

  it('accepts the uuid shape it will actually be given', () => {
    const u = '32f2b123-6b25-4ef0-9e05-afc8705ae1f9'
    expect(withSessionId('claude', 'claude', u)).toBe(`claude --session-id ${u}`)
  })
})

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
