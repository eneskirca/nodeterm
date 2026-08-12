import { describe, expect, it } from 'vitest'
import { applyCustomAgentEnv, customAgentEnvArgs } from './custom-agent-env'
import type { CustomAgent } from '../shared/types'

const PROC = { MY_TOKEN: 'sk-abc', PATH: '/usr/bin:/bin' }

describe('applyCustomAgentEnv', () => {
  it('returns the env unchanged (shallow copy) when there is no custom agent / no env', () => {
    expect(applyCustomAgentEnv({ A: '1' }, undefined, PROC)).toEqual({
      env: { A: '1' },
      warnings: []
    })
    const noEnv: CustomAgent = { id: 'custom:x', label: 'X', launchCmd: 'x' }
    expect(applyCustomAgentEnv({ A: '1' }, noEnv, PROC)).toEqual({
      env: { A: '1' },
      warnings: []
    })
  })

  it('merges custom env LAST so it wins over the existing env', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { ANTHROPIC_AUTH_TOKEN: 'proxy-token', NEW: 'n' }
    }
    const r = applyCustomAgentEnv({ ANTHROPIC_AUTH_TOKEN: 'account-token', KEEP: 'k' }, custom, PROC)
    expect(r.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      KEEP: 'k',
      NEW: 'n'
    })
    expect(r.warnings).toEqual([])
  })

  it('expands ${env:VAR} against the process env', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { TOKEN: '${env:MY_TOKEN}' }
    }
    expect(applyCustomAgentEnv({}, custom, PROC).env).toEqual({ TOKEN: 'sk-abc' })
  })

  it('warns when a referenced var is unset with no fallback', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { TOKEN: '${env:MISSING}' }
    }
    const r = applyCustomAgentEnv({}, custom, PROC)
    expect(r.env).toEqual({ TOKEN: '' })
    expect(r.warnings.join('\n')).toContain('${env:MISSING}')
    expect(r.warnings.join('\n')).toContain('Proxy')
  })

  it('uses the fallback and does not warn when the var is unset', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { TOKEN: '${env:MISSING:dev-key}' }
    }
    const r = applyCustomAgentEnv({}, custom, PROC)
    expect(r.env).toEqual({ TOKEN: 'dev-key' })
    expect(r.warnings).toEqual([])
  })

  it('warns when a custom PATH clobbers the inherited PATH', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { PATH: '/my/bin' }
    }
    const r = applyCustomAgentEnv({ PATH: '/usr/bin' }, custom, PROC)
    expect(r.env.PATH).toBe('/my/bin')
    expect(r.warnings.join('\n')).toContain('${env:PATH}')
  })

  it('does not warn when a custom PATH preserves the inherited PATH', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { PATH: '${env:PATH}:/my/bin' }
    }
    const r = applyCustomAgentEnv({ PATH: '/usr/bin' }, custom, PROC)
    expect(r.env.PATH).toBe('/usr/bin:/bin:/my/bin')
    expect(r.warnings).toEqual([])
  })

  it('skipPath drops a custom PATH and warns (remote nodes)', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { PATH: '${env:PATH}:/my/bin', OTHER: 'x' }
    }
    const r = applyCustomAgentEnv({ PATH: '/usr/bin' }, custom, PROC, { skipPath: true })
    expect(r.env).toEqual({ PATH: '/usr/bin', OTHER: 'x' })
    expect(r.warnings.join('\n')).toContain('not applied to remote')
  })
})

describe('customAgentEnvArgs', () => {
  it('returns KEY=VALUE pairs for the tmux -e list', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { TOKEN: '${env:MY_TOKEN}', BASE: 'http://x' }
    }
    expect(customAgentEnvArgs(custom, PROC).args).toEqual(['TOKEN=sk-abc', 'BASE=http://x'])
  })
  it('skipPath drops PATH', () => {
    const custom: CustomAgent = {
      id: 'custom:p',
      label: 'Proxy',
      launchCmd: 'claude',
      env: { PATH: '/x', TOKEN: 't' }
    }
    const r = customAgentEnvArgs(custom, PROC, { skipPath: true })
    expect(r.args).toEqual(['TOKEN=t'])
    expect(r.warnings.join('\n')).toContain('remote')
  })
  it('empty for no custom env', () => {
    expect(customAgentEnvArgs(undefined, PROC)).toEqual({ args: [], warnings: [] })
  })
})
