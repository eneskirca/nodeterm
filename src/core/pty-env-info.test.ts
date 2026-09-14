import { describe, expect, it } from 'vitest'
import {
  isSecretEnvKey,
  isSecretEnvValue,
  maskPtyEnv,
  maskPtyEnvVar,
  parseTmuxSessionEnv
} from './pty-env-info'

describe('isSecretEnvKey', () => {
  it('marks the credential-shaped names the env layers actually write', () => {
    expect(isSecretEnvKey('ANTHROPIC_AUTH_TOKEN')).toBe(true)
    expect(isSecretEnvKey('ANTHROPIC_API_KEY')).toBe(true)
    expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true)
    expect(isSecretEnvKey('COPILOT_PROVIDER_API_KEY')).toBe(true)
    expect(isSecretEnvKey('MY_CUSTOM_OAUTH_SECRET')).toBe(true)
    expect(isSecretEnvKey('my_project_password')).toBe(true)
  })

  it('does NOT mark plain config names — including suffix look-alikes', () => {
    // The gateway / autocompact / hook vars carry no credential.
    expect(isSecretEnvKey('ANTHROPIC_BASE_URL')).toBe(false)
    expect(isSecretEnvKey('CLAUDE_CODE_AUTO_COMPACT_WINDOW')).toBe(false)
    expect(isSecretEnvKey('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')).toBe(false)
    expect(isSecretEnvKey('CLAUDE_CODE_SUBAGENT_MODEL')).toBe(false)
    expect(isSecretEnvKey('CLAUDE_CONFIG_DIR')).toBe(false)
    expect(isSecretEnvKey('NODETERM_HOOK_ENDPOINT')).toBe(false)
    // Socket/pid names end in SOCK/PID and must not mask.
    expect(isSecretEnvKey('SSH_AUTH_SOCK')).toBe(false)
    expect(isSecretEnvKey('SSH_AGENT_PID')).toBe(false)
  })
})

describe('isSecretEnvValue', () => {
  it('finds credentials hidden behind ordinary URL and connection-string names', () => {
    expect(isSecretEnvValue('postgres://app:super-secret@db.internal/app')).toBe(true)
    expect(isSecretEnvValue('jdbc:postgresql://app:super-secret@db.internal/app')).toBe(true)
    expect(isSecretEnvValue('Server=db;User Id=app;Password=super-secret')).toBe(true)
    expect(isSecretEnvValue('-----BEGIN PRIVATE KEY-----\nabc')).toBe(true)
  })

  it('keeps ordinary diagnostic endpoints visible', () => {
    expect(isSecretEnvValue('https://bifrost.example/anthropic')).toBe(false)
    expect(isSecretEnvValue('postgres://db.internal/app')).toBe(false)
    expect(isSecretEnvValue('/usr/local/bin:/usr/bin:/bin')).toBe(false)
  })
})

describe('maskPtyEnvVar', () => {
  it('masks a secret value keeping only the ends', () => {
    const v = maskPtyEnvVar('ANTHROPIC_AUTH_TOKEN', 'sk-ant-01234567890abcdefghijklmnop', true)
    expect(v.secret).toBe(true)
    expect(v.value.startsWith('sk-')).toBe(true)
    expect(v.value.endsWith('mnop')).toBe(true)
    expect(v.value).not.toContain('0123456789')
  })

  it('short secrets mask completely (no ends to preserve)', () => {
    const v = maskPtyEnvVar('TOKEN', 'abc', true)
    expect(v.secret).toBe(true)
    expect(v.value).toBe('•••')
  })

  it('a non-secret value passes verbatim; an unset var reports "(not set)"', () => {
    expect(maskPtyEnvVar('CLAUDE_CODE_AUTO_COMPACT_WINDOW', '400000', true)).toEqual({
      key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      value: '400000'
    })
    expect(maskPtyEnvVar('SOMETHING_UNSET', undefined, false)).toEqual({
      key: 'SOMETHING_UNSET',
      value: '(not set)',
      set: false
    })
  })

  it('masks credential-bearing values even when the environment name looks harmless', () => {
    const v = maskPtyEnvVar('DATABASE_URL', 'postgres://app:super-secret@db.internal/app', true)
    expect(v.secret).toBe(true)
    expect(v.value).not.toContain('super-secret')
  })
})

describe('maskPtyEnv', () => {
  it('renders the whole map sorted by key, masking only credentials', () => {
    const vars = maskPtyEnv({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      ANTHROPIC_AUTH_TOKEN: 'sk-very-secret-value-here',
      ANTHROPIC_BASE_URL: 'https://bifrost.example/anthropic'
    })
    expect(vars.map((v) => v.key)).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
    ])
    expect(vars[0].secret).toBe(true)
    expect(vars[0].value).not.toContain('secret-value')
    expect(vars[1].value).toBe('https://bifrost.example/anthropic')
    expect(vars[2].value).toBe('400000')
  })
})

describe('parseTmuxSessionEnv', () => {
  it('parses shell-formatted records, masks credentials, and sorts', () => {
    const vars = parseTmuxSessionEnv(
      [
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW="400000"; export CLAUDE_CODE_AUTO_COMPACT_WINDOW;',
        'ANTHROPIC_AUTH_TOKEN="sk-live-token-abcdef"; export ANTHROPIC_AUTH_TOKEN;',
        'PATH="/usr/bin:/bin"; export PATH;'
      ].join('\n') + '\n'
    )
    expect(vars.map((v) => v.key)).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'PATH'
    ])
    expect(vars[0].secret).toBe(true)
    expect(vars[0].value).not.toContain('abcdef')
    expect(vars[1].value).toBe('400000')
    expect(vars[2].value).toBe('/usr/bin:/bin')
  })

  it('renders an unset var as "(not set)", never as a blank cell', () => {
    const vars = parseTmuxSessionEnv(
      ['unset OPENAI_API_KEY;', 'TERM="tmux-256color"; export TERM;'].join('\n') + '\n'
    )
    const unset = vars.find((v) => v.key === 'OPENAI_API_KEY')
    expect(unset).toEqual({ key: 'OPENAI_API_KEY', value: '(not set)', set: false })
  })

  it('keeps multiline secrets and embedded fake records inside one masked value', () => {
    const vars = parseTmuxSessionEnv(
      'DEMO_TOKEN="artificial-secret-line1\nINNOCENT=artificial-secret-line2"; export DEMO_TOKEN;\n' +
        'KEY_MATERIAL="-----BEGIN PRIVATE KEY-----\nEVIL=\\"visible\\"; export EVIL;"; export KEY_MATERIAL;\n'
    )
    expect(vars.map((v) => v.key)).toEqual(['DEMO_TOKEN', 'KEY_MATERIAL'])
    expect(vars.every((v) => v.secret)).toBe(true)
    expect(vars.some((v) => v.key === 'INNOCENT' || v.key === 'EVIL')).toBe(false)
  })

  it('decodes only the quoting escapes emitted by tmux and preserves literal controls', () => {
    const vars = parseTmuxSessionEnv(
      'VALUE="space newline\ntab\t quote\\" slash\\\\ dollar\\$ tick\\`"; export VALUE;\n'
    )
    expect(vars).toEqual([
      { key: 'VALUE', value: 'space newline\ntab\t quote" slash\\ dollar$ tick`' }
    ])
  })

  it.each([
    'BROKEN="unterminated',
    'A="value"; export B;\n',
    'A-B="value"; export A-B;\n',
    'A="bad\\q"; export A;\n',
    'A="one"; export A;\nA="two"; export A;\n',
    'A="one"; export A;\r\n',
    'stray text\n'
  ])('fails closed on malformed shell output %#', (stdout) => {
    expect(() => parseTmuxSessionEnv(stdout)).toThrow()
  })
})
