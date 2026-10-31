import { describe, it, expect } from 'vitest'
import { isBusyAgentState, parseControlScope, parseForceFlag } from './control-scope'
import { resolveConfig } from './config'

describe('control scope', () => {
  it('defaults to creator and refuses an unknown value', () => {
    expect(parseControlScope(undefined)).toBe('creator')
    expect(parseControlScope('')).toBe('creator')
    expect(parseControlScope(' Project ')).toBe('project')
    expect(() => parseControlScope('everything')).toThrow(/creator, project/)
  })

  it('treats working, waiting and blocked as busy; done and unknown are not', () => {
    expect(['working', 'waiting', 'blocked'].every((s) => isBusyAgentState(s as never))).toBe(true)
    expect(isBusyAgentState('done')).toBe(false)
    expect(isBusyAgentState(undefined)).toBe(false)
  })

  it('reads --force as yes/no, never a guess', () => {
    expect(parseForceFlag(undefined)).toBe(false)
    expect(parseForceFlag('yes')).toBe(true)
    expect(parseForceFlag('no')).toBe(false)
    expect(parseForceFlag('sure')).toEqual({ error: expect.stringContaining('yes or no') })
  })

  it('is read from the flag or the environment, and a typo fails the boot', () => {
    expect(resolveConfig({}, []).controlScope).toBe('creator')
    expect(resolveConfig({ NODETERM_SERVER_CONTROL_SCOPE: 'project' }, []).controlScope).toBe('project')
    expect(resolveConfig({}, ['--control-scope', 'project']).controlScope).toBe('project')
    expect(() => resolveConfig({}, ['--control-scope', 'all'])).toThrow(/control-scope/)
    // A bare flag is not a choice either.
    expect(() => resolveConfig({}, ['--control-scope'])).toThrow(/control-scope/)
  })
})
