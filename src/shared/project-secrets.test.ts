import { describe, expect, it } from 'vitest'
import {
  PROJECT_SECRETS_MAX,
  displayArg,
  displayCommand,
  isReservedSecretName,
  normalizeCrossProjectSecretsPolicy,
  sanitizeSecretDecls,
  secretDeclKey
} from './project-secrets'
import { sanitizeProjectSettingsDoc, resolveProjectSettings } from './project-settings'
import { SETTINGS_VERB_FORBIDDEN_PATTERN } from './settings-verb'

describe('sanitizeSecretDecls — settings.json is git-shared hostile input', () => {
  it('keeps well-formed declarations in order', () => {
    expect(
      sanitizeSecretDecls([
        { env: 'API_TOKEN', command: ['op', 'read', 'op://x/y'] },
        { env: 'B', command: ['./print'] }
      ])
    ).toEqual([
      { env: 'API_TOKEN', command: ['op', 'read', 'op://x/y'] },
      { env: 'B', command: ['./print'] }
    ])
  })

  it('drops a string command (it would need a shell), an empty argv and a blank program', () => {
    expect(sanitizeSecretDecls([{ env: 'A', command: 'op read x' }])).toBeUndefined()
    expect(sanitizeSecretDecls([{ env: 'A', command: [] }])).toBeUndefined()
    expect(sanitizeSecretDecls([{ env: 'A', command: ['  '] }])).toBeUndefined()
    expect(sanitizeSecretDecls([{ env: 'A', command: ['x', 'a\0b'] }])).toBeUndefined()
    expect(sanitizeSecretDecls([{ env: 'A', command: ['x', 5] }])).toBeUndefined()
  })

  it('drops reserved and malformed names, case-insensitively, and duplicates after the first', () => {
    const got = sanitizeSecretDecls([
      { env: 'PATH', command: ['x'] },
      { env: 'Path', command: ['x'] },
      { env: 'LD_PRELOAD', command: ['x'] },
      { env: 'NODETERM_NODE_ID', command: ['x'] },
      { env: 'XDG_CONFIG_HOME', command: ['x'] },
      { env: '1BAD', command: ['x'] },
      { env: '__proto__', command: ['x'] },
      { env: 'OK', command: ['first'] },
      { env: 'ok', command: ['second'] }
    ])
    expect(got).toEqual([{ env: 'OK', command: ['first'] }])
  })

  it('never throws and caps the list', () => {
    for (const bad of [null, 1, 'x', {}, [null], [[]], [{}]]) expect(() => sanitizeSecretDecls(bad)).not.toThrow()
    const many = Array.from({ length: PROJECT_SECRETS_MAX + 5 }, (_, i) => ({ env: `V${i}`, command: ['x'] }))
    expect(sanitizeSecretDecls(many)).toHaveLength(PROJECT_SECRETS_MAX)
  })

  it('flows through the project settings document and the local-over-shared resolver', () => {
    const shared = sanitizeProjectSettingsDoc({ agents: { secrets: [{ env: 'A', command: ['s'] }] } })
    const local = sanitizeProjectSettingsDoc({ agents: { secrets: [{ env: 'A', command: ['l'] }] } })
    expect(resolveProjectSettings(undefined, shared).agents.secrets).toEqual({
      value: [{ env: 'A', command: ['s'] }],
      source: 'shared'
    })
    expect(resolveProjectSettings(local, shared).agents.secrets?.source).toBe('local')
    expect(sanitizeProjectSettingsDoc({ agents: { secrets: 'nope' } }).agents).toBeUndefined()
  })
})

describe('reserved names', () => {
  it('cover Infisical\'s never-injected list and the spawn-critical names', () => {
    for (const n of ['HOME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER', 'LC_ALL', 'NODE_OPTIONS', 'tmux']) {
      expect(isReservedSecretName(n), n).toBe(true)
    }
    expect(isReservedSecretName('GITHUB_TOKEN')).toBe(false)
  })
})

describe('declaration binding', () => {
  it('changes when the command changes', () => {
    expect(secretDeclKey({ env: 'A', command: ['x'] })).not.toBe(secretDeclKey({ env: 'A', command: ['y'] }))
    expect(secretDeclKey({ env: 'A', command: ['x', 'y'] })).not.toBe(secretDeclKey({ env: 'A', command: ['x y'] }))
  })
})

describe('displayCommand — what the person approves is what runs', () => {
  it('shows plain arguments as they are and quotes the rest', () => {
    expect(displayCommand(['op', 'read', 'op://a b/c'])).toBe('op read "op://a b/c"')
    expect(displayArg('')).toBe('""')
    expect(displayArg('q"\\')).toBe('"q\\"\\\\"')
  })

  it('makes invisible and bidi characters visible', () => {
    expect(displayArg('evil‮cod.exe')).toBe('"evil\\u{202e}cod.exe"')
    expect(displayArg('a​b')).toBe('"a\\u{200b}b"')
    expect(displayArg('line\nbreak')).toBe('"line\\u{a}break"')
  })
})

describe('cross-project policy', () => {
  it('reads anything unknown as the default', () => {
    expect(normalizeCrossProjectSecretsPolicy('allow')).toBe('allow')
    expect(normalizeCrossProjectSecretsPolicy('ask')).toBe('ask')
    for (const v of [undefined, null, 'ALLOW', 1, 'deny']) expect(normalizeCrossProjectSecretsPolicy(v)).toBe('deny')
  })

  it('cannot be changed from the canvas CLI (the settings verb forbids the name)', () => {
    expect(SETTINGS_VERB_FORBIDDEN_PATTERN.test('projectSecretsCrossProject')).toBe(true)
  })
})
