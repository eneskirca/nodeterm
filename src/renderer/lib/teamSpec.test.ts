import { describe, it, expect } from 'vitest'
import { parseTeamSpec, TEAM_MAX_ROLES } from './teamSpec'

const KNOWN = new Set(['claude', 'codex', 'gemini', 'opencode', 'custom:mine'])

const err = (raw: string, disabled: ReadonlySet<string> = new Set()): string => {
  const r = parseTeamSpec(raw, KNOWN, disabled)
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}

describe('parseTeamSpec — the happy path', () => {
  it('parses roles, defaulting agent to claude and trimming fields', () => {
    const r = parseTeamSpec(
      '[{"title":" UI ","prompt":"build it","model":" sonnet "},{"prompt":"test it","agent":"codex"}]',
      KNOWN
    )
    expect(r).toEqual({
      ok: true,
      roles: [
        { title: 'UI', prompt: 'build it', agent: 'claude', model: 'sonnet' },
        { prompt: 'test it', agent: 'codex' }
      ]
    })
  })
  it('accepts promptFile in place of prompt', () => {
    const r = parseTeamSpec('[{"title":"UI","promptFile":"/tmp/brief.md"}]', KNOWN)
    expect(r).toEqual({
      ok: true,
      roles: [{ title: 'UI', promptFile: '/tmp/brief.md', agent: 'claude' }]
    })
  })
  it('accepts a custom agent id when it is in the known set', () => {
    const r = parseTeamSpec('[{"prompt":"x","agent":"custom:mine"}]', KNOWN)
    expect(r.ok).toBe(true)
  })
})

describe('parseTeamSpec — every mistake is a NAMED refusal (issue #532)', () => {
  it('empty payload', () => {
    expect(err('')).toMatch(/--team is empty/)
  })
  it('invalid JSON names the parse error and shows the expected shape', () => {
    const e = err('[{"title":"UI"')
    expect(e).toMatch(/not valid JSON/)
    expect(e).toContain('promptFile')
  })
  it('a bare object is refused as not-an-array', () => {
    expect(err('{"prompt":"x"}')).toMatch(/ARRAY/)
  })
  it('an empty array is refused', () => {
    expect(err('[]')).toMatch(/at least one role/)
  })
  it(`a ${TEAM_MAX_ROLES + 1}th role is refused, not silently sliced off`, () => {
    const roles = JSON.stringify(
      Array.from({ length: TEAM_MAX_ROLES + 1 }, (_, i) => ({ prompt: `t${i}` }))
    )
    expect(err(roles)).toMatch(new RegExp(`${TEAM_MAX_ROLES + 1} roles — max ${TEAM_MAX_ROLES}`))
  })
  it('a role missing its prompt is refused BY NAME, not silently dropped', () => {
    // The old inline parse filtered this role out: the team opened short and nobody said which
    // role vanished. Now the reply names it.
    expect(err('[{"prompt":"a"},{"title":"Docs"}]')).toContain('"Docs"')
    expect(err('[{"prompt":"a"},{}]')).toContain('#2')
  })
  it('a role with both prompt and promptFile is refused', () => {
    expect(err('[{"title":"UI","prompt":"a","promptFile":"/x"}]')).toMatch(/not both/)
  })
  it('a non-string field is refused by field name', () => {
    expect(err('[{"prompt":42}]')).toContain('"prompt" must be a string')
    expect(err('[{"prompt":"a","model":7}]')).toContain('"model" must be a string')
  })
  it('a relative promptFile is refused (same rule as --prompt-file)', () => {
    expect(err('[{"title":"UI","promptFile":"brief.md"}]')).toMatch(/absolute/)
  })
  it('an unknown agent id is refused with the known list', () => {
    const e = err('[{"prompt":"x","agent":"claudee"}]')
    expect(e).toContain('unknown agent "claudee"')
    expect(e).toContain('codex')
  })
  it('a disabled builtin agent id is refused by role name', () => {
    const e = err('[{"title":"Worker","prompt":"x","agent":"opencode"}]', new Set(['opencode']))
    expect(e).toBe('role "Worker": agent "opencode" is disabled in Settings')
  })
  it('a disabled custom agent id is refused by role name', () => {
    const e = err('[{"prompt":"x","agent":"custom:mine"}]', new Set(['custom:mine']))
    expect(e).toBe('role #1: agent "custom:mine" is disabled in Settings')
  })
  it('a role omitting agent is refused when claude is disabled', () => {
    const e = err('[{"title":"DefaultRole","prompt":"x"}]', new Set(['claude']))
    expect(e).toBe('role "DefaultRole": agent "claude" is disabled in Settings')
  })
  it('a non-object role is refused by position', () => {
    expect(err('["just a string"]')).toContain('#1')
  })
})
