import { describe, expect, it } from 'vitest'
import { expandEnvVars, preservesInheritedPath } from './expansion'

describe('expandEnvVars', () => {
  it('returns the input unchanged when no token is present', () => {
    expect(expandEnvVars('claude --resume abc', { FOO: 'bar' })).toEqual({
      value: 'claude --resume abc',
      missing: []
    })
  })

  it('expands ${env:VAR} to the env value (VS Code colon syntax)', () => {
    expect(expandEnvVars('${env:MY_API_KEY}', { MY_API_KEY: 'sk-123' })).toEqual({
      value: 'sk-123',
      missing: []
    })
  })

  it('uses the fallback when the var is unset (${env:VAR:fallback})', () => {
    expect(expandEnvVars('${env:MISSING:dev-key}', {})).toEqual({
      value: 'dev-key',
      missing: []
    })
  })

  it('records a missing var with no fallback as empty + missing', () => {
    expect(expandEnvVars('${env:NOPE}', {})).toEqual({ value: '', missing: ['NOPE'] })
  })

  it('expands a token embedded in surrounding text', () => {
    expect(
      expandEnvVars('ANTHROPIC_BASE_URL=${env:BASE}/v1', { BASE: 'http://localhost:8080' })
    ).toEqual({ value: 'ANTHROPIC_BASE_URL=http://localhost:8080/v1', missing: [] })
  })

  it('expands multiple tokens and reports only the truly missing ones', () => {
    const r = expandEnvVars('${env:A}/${env:B}:${env:C:default}/${env:D}', {
      A: 'a',
      B: 'b'
    })
    expect(r).toEqual({ value: 'a/b:default/', missing: ['D'] })
  })

  it('treats an empty-string env value as unset (uses fallback / missing)', () => {
    expect(expandEnvVars('${env:EMPTY:fallback}', { EMPTY: '' })).toEqual({
      value: 'fallback',
      missing: []
    })
    expect(expandEnvVars('${env:EMPTY}', { EMPTY: '' })).toEqual({
      value: '',
      missing: ['EMPTY']
    })
  })

  it('only matches the env namespace (does not expand ${config:…})', () => {
    expect(expandEnvVars('${config:foo}', { foo: 'x' })).toEqual({
      value: '${config:foo}',
      missing: []
    })
  })
})

describe('preservesInheritedPath', () => {
  it('true when there is no PATH override', () => {
    expect(preservesInheritedPath(undefined)).toBe(true)
    expect(preservesInheritedPath('')).toBe(true)
  })
  it('true when the value references ${env:PATH}', () => {
    expect(preservesInheritedPath('${env:PATH}:/my/bin')).toBe(true)
  })
  it('false when the value clobbers PATH outright', () => {
    expect(preservesInheritedPath('/my/bin')).toBe(false)
  })
})
